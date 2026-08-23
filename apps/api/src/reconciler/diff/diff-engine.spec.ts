import {
  INPUT_LABELS,
  MIRROR_LABELS,
} from '../../github/labels/factory-labels';
import type { NormalizedIssue } from '../../github/read/github-read.types';
import { projectDesiredState } from '../projection/desired-state';
import type {
  ObservedState,
  ObservedWorkOrder,
} from '../projection/desired-state.types';
import type { ReconcileAction, ReconcileActionType } from './actions.types';
import { computeActions } from './diff-engine';

function issue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    number: 312,
    title: 'Add CSV export',
    body: 'body',
    state: 'open',
    author: 'marinoscar',
    labels: [],
    inputLabels: [],
    unknownInputLabels: [],
    observedMirrorLabels: [],
    isPullRequest: false,
    url: 'https://github.com/acme/app/issues/312',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-02T00:00:00Z'),
    ...overrides,
  };
}

function workOrder(
  overrides: Partial<ObservedWorkOrder> = {},
): ObservedWorkOrder {
  return {
    id: 'wo-uuid',
    identity: 'wo_app_312_a3f91c2_a1',
    issueNumber: 312,
    attempt: 1,
    status: 'dispatched',
    run: null,
    ...overrides,
  };
}

function observed(overrides: Partial<ObservedState> = {}): ObservedState {
  return {
    repository: {
      id: 'repo-uuid',
      owner: 'acme',
      name: 'app',
      observeEnabled: true,
      dispatchEnabled: true,
      budgetCeilingUsd: null,
    },
    issues: [issue()],
    workOrders: [],
    humanClearedQuarantine: new Set<number>(),
    // High enough that the ceiling is never the thing under test here; the
    // cases that exercise it set it explicitly.
    retryCeiling: 99,
    ...overrides,
  };
}

/** Run the real projection, then the diff — the two are always used together. */
function actionsFor(state: ObservedState): ReconcileAction[] {
  return computeActions(state, projectDesiredState(state));
}

function types(actions: ReconcileAction[]): ReconcileActionType[] {
  return actions.map((a) => a.type);
}

describe('computeActions', () => {
  describe('every action type is produced by some input', () => {
    it('dispatch', () => {
      const actions = actionsFor(
        observed({ issues: [issue({ inputLabels: [INPUT_LABELS.READY] })] }),
      );

      expect(types(actions)).toContain('dispatch');
    });

    it('hold', () => {
      const actions = actionsFor(
        observed({ issues: [issue({ inputLabels: [INPUT_LABELS.HOLD] })] }),
      );

      expect(types(actions)).toContain('hold');
    });

    it('quarantine', () => {
      const actions = actionsFor(
        observed({
          issues: [issue({ inputLabels: [INPUT_LABELS.READY] })],
          workOrders: [
            workOrder({
              run: {
                id: 'r',
                status: 'failed',
                costUsd: 10,
                pullRequestUrl: null,
              },
            }),
          ],
          repository: {
            id: 'r',
            owner: 'acme',
            name: 'app',
            observeEnabled: true,
            dispatchEnabled: true,
            budgetCeilingUsd: 5,
          },
        }),
      );

      expect(types(actions)).toContain('quarantine');
    });

    it('release-quarantine', () => {
      const actions = actionsFor(
        observed({
          issues: [issue({ inputLabels: [INPUT_LABELS.CLEAR_QUARANTINE] })],
          workOrders: [workOrder({ status: 'quarantined' })],
          humanClearedQuarantine: new Set([312]),
        }),
      );

      expect(types(actions)).toContain('release-quarantine');
    });

    it('add-mirror-label', () => {
      const actions = actionsFor(
        observed({ issues: [issue({ inputLabels: [INPUT_LABELS.READY] })] }),
      );

      expect(actions.find((a) => a.type === 'add-mirror-label')?.label).toBe(
        MIRROR_LABELS.DISPATCHED,
      );
    });

    it('remove-mirror-label', () => {
      const actions = actionsFor(
        observed({
          issues: [issue({ observedMirrorLabels: [MIRROR_LABELS.DISPATCHED] })],
        }),
      );

      expect(actions.find((a) => a.type === 'remove-mirror-label')?.label).toBe(
        MIRROR_LABELS.DISPATCHED,
      );
    });
  });

  describe('mirror-label reconciliation', () => {
    it('does not re-add a label that is already correct', () => {
      // Otherwise every tick rewrites every label, which burns the rate-limit
      // budget and fills the review log with no-ops.
      const actions = actionsFor(
        observed({
          issues: [
            issue({
              inputLabels: [INPUT_LABELS.READY],
              observedMirrorLabels: [MIRROR_LABELS.DISPATCHED],
            }),
          ],
        }),
      );

      expect(types(actions)).not.toContain('add-mirror-label');
      expect(types(actions)).not.toContain('remove-mirror-label');
    });

    it('removes a STALE label from a previous state', () => {
      // #48: "A stale mirror label from a previous run is removed, not just
      // added to." Without this a work order that ran, blocked, then succeeded
      // accumulates all three labels and they stop meaning anything.
      const actions = actionsFor(
        observed({
          issues: [
            issue({
              observedMirrorLabels: [
                MIRROR_LABELS.DISPATCHED,
                MIRROR_LABELS.BLOCKED,
              ],
            }),
          ],
          workOrders: [
            workOrder({
              run: {
                id: 'r',
                status: 'succeeded',
                costUsd: null,
                pullRequestUrl: 'https://x/pull/9',
              },
            }),
          ],
        }),
      );

      const removed = actions
        .filter((a) => a.type === 'remove-mirror-label')
        .map((a) => a.label);
      const added = actions
        .filter((a) => a.type === 'add-mirror-label')
        .map((a) => a.label);

      expect(removed.sort()).toEqual(
        [MIRROR_LABELS.BLOCKED, MIRROR_LABELS.DISPATCHED].sort(),
      );
      expect(added).toEqual([MIRROR_LABELS.REVIEW]);
    });

    it('leaves a factory/ label Opifex does not own alone', () => {
      // Deleting a label because we do not recognise it is the kind of
      // destructive surprise that makes an operator switch the system off.
      const actions = actionsFor(
        observed({
          issues: [
            issue({ observedMirrorLabels: ['factory/someones-own-label'] }),
          ],
        }),
      );

      expect(types(actions)).not.toContain('remove-mirror-label');
    });

    it('strips every mirror label from a held issue', () => {
      const actions = actionsFor(
        observed({
          issues: [
            issue({
              inputLabels: [INPUT_LABELS.HOLD],
              observedMirrorLabels: [MIRROR_LABELS.DISPATCHED],
            }),
          ],
        }),
      );

      expect(
        actions.filter((a) => a.type === 'remove-mirror-label'),
      ).toHaveLength(1);
    });
  });

  describe('quiet ticks stay quiet', () => {
    it('produces NO actions for an ignored issue with no labels', () => {
      expect(actionsFor(observed())).toEqual([]);
    });

    it('produces no actions for a correctly-labelled running work order', () => {
      // A steady state should cost nothing. If a healthy factory emitted
      // actions every minute, a week of log would be unreviewable.
      const actions = actionsFor(
        observed({
          issues: [
            issue({
              inputLabels: [INPUT_LABELS.READY],
              observedMirrorLabels: [MIRROR_LABELS.DISPATCHED],
            }),
          ],
          workOrders: [
            workOrder({
              run: {
                id: 'r',
                status: 'running',
                costUsd: null,
                pullRequestUrl: null,
              },
            }),
          ],
        }),
      );

      expect(actions).toEqual([]);
    });

    it('does not re-quarantine something already quarantined', () => {
      const actions = actionsFor(
        observed({
          issues: [issue({ observedMirrorLabels: [MIRROR_LABELS.QUARANTINE] })],
          workOrders: [workOrder({ status: 'quarantined' })],
        }),
      );

      expect(actions).toEqual([]);
    });
  });

  describe('the reason and its evidence', () => {
    it('names the specific inputs that produced the decision', () => {
      // #47: a reviewer must be able to reconstruct the decision from the log
      // entry ALONE, without reading code.
      const [action] = actionsFor(
        observed({ issues: [issue({ inputLabels: [INPUT_LABELS.READY] })] }),
      );

      expect(action.reason).toContain(INPUT_LABELS.READY);
      expect(action.evidence).toMatchObject({
        intent: 'dispatch',
        inputLabels: [INPUT_LABELS.READY],
      });
    });

    it('carries the evidence separately from the prose', () => {
      // A reason can be subtly wrong while sounding right; the evidence is
      // what makes that detectable.
      // A blocked run whose label is STALE — the steady-state case produces no
      // action at all (asserted elsewhere), so the evidence has to be checked
      // on a transition.
      const [action] = actionsFor(
        observed({
          issues: [
            issue({
              inputLabels: [INPUT_LABELS.READY],
              observedMirrorLabels: [MIRROR_LABELS.DISPATCHED],
            }),
          ],
          workOrders: [
            workOrder({
              run: {
                id: 'r',
                status: 'blocked',
                costUsd: null,
                pullRequestUrl: null,
              },
            }),
          ],
        }),
      );

      expect(action.evidence).toMatchObject({
        intent: 'blocked',
        workOrderIdentity: 'wo_app_312_a3f91c2_a1',
        runStatus: 'blocked',
        // What is written NOW, versus what should be — the pair a reviewer
        // needs to check the label decision without reading code.
        currentMirrorLabels: [MIRROR_LABELS.DISPATCHED],
        desiredMirrorLabels: [MIRROR_LABELS.BLOCKED],
      });
    });

    it('gives every action a non-empty reason', () => {
      const actions = actionsFor(
        observed({
          issues: [
            issue({ number: 1, inputLabels: [INPUT_LABELS.READY] }),
            issue({
              number: 2,
              inputLabels: [INPUT_LABELS.HOLD],
              observedMirrorLabels: [MIRROR_LABELS.DISPATCHED],
            }),
          ],
        }),
      );

      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action.reason.length).toBeGreaterThan(0);
      }
    });
  });

  describe('the properties #47 requires', () => {
    it('is deterministic: identical inputs give an identical list', () => {
      const state = observed({
        issues: [
          issue({ number: 9, inputLabels: [INPUT_LABELS.READY] }),
          issue({ number: 3, inputLabels: [INPUT_LABELS.HOLD] }),
        ],
      });

      expect(actionsFor(state)).toEqual(actionsFor(state));
    });

    it('orders issues ascending, so two ticks can be diffed', () => {
      const actions = actionsFor(
        observed({
          issues: [
            issue({ number: 9, inputLabels: [INPUT_LABELS.READY] }),
            issue({ number: 3, inputLabels: [INPUT_LABELS.READY] }),
          ],
        }),
      );

      expect(actions.map((a) => a.issueNumber)).toEqual([3, 3, 9, 9]);
    });

    it('returns actions that are serializable data, not closures', () => {
      // A closure can be executed but not reviewed, and review is the
      // deliverable of the observation week.
      const actions = actionsFor(
        observed({ issues: [issue({ inputLabels: [INPUT_LABELS.READY] })] }),
      );

      expect(JSON.parse(JSON.stringify(actions))).toEqual(actions);
      for (const action of actions) {
        for (const value of Object.values(action)) {
          expect(typeof value).not.toBe('function');
        }
      }
    });

    it('does not mutate its inputs', () => {
      const state = observed({
        issues: [
          issue({
            inputLabels: [INPUT_LABELS.READY],
            observedMirrorLabels: [MIRROR_LABELS.BLOCKED],
          }),
        ],
      });
      const before = JSON.stringify(state, (_k, v) =>
        v instanceof Set ? [...v] : v,
      );

      actionsFor(state);

      expect(
        JSON.stringify(state, (_k, v) => (v instanceof Set ? [...v] : v)),
      ).toBe(before);
    });

    it('has no way to execute anything', () => {
      // The guarantee is structural: `computeActions` takes data and returns
      // data. No client, no adapter, no callback — nothing it holds could
      // perform a write even if a future change asked it to.
      expect(computeActions).toHaveLength(2);
      const source = computeActions.toString();
      expect(source).not.toMatch(/await|fetch|prisma|http/i);
    });
  });
});
