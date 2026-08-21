import { INPUT_LABELS, MIRROR_LABELS } from '../../github/labels/factory-labels';
import type { NormalizedIssue } from '../../github/read/github-read.types';
import { assertNoMirrorLabelsObserved, projectDesiredState } from './desired-state';
import type {
  ObservedState,
  ObservedWorkOrder,
  RunStatusLike,
  WorkOrderStatusLike,
} from './desired-state.types';

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

function workOrder(overrides: Partial<ObservedWorkOrder> = {}): ObservedWorkOrder {
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
    ...overrides,
  };
}

/** The single projected issue, for the common one-issue case. */
function project(state: ObservedState) {
  return projectDesiredState(state).issues[0];
}

describe('projectDesiredState', () => {
  describe('precedence: factory:hold', () => {
    it('holds an issue that would otherwise dispatch', async () => {
      // VISION §4 promises "Put factory:hold on an issue and it stops." A
      // brake evaluated after anything else is a brake with conditions.
      const result = project(
        observed({
          issues: [issue({ inputLabels: [INPUT_LABELS.HOLD, INPUT_LABELS.READY] })],
        }),
      );

      expect(result.intent).toBe('hold');
      expect(result.reason).toContain('a human applied');
    });

    it('holds an issue with a live run', () => {
      const result = project(
        observed({
          issues: [issue({ inputLabels: [INPUT_LABELS.HOLD] })],
          workOrders: [workOrder({ run: { id: 'r', status: 'running', costUsd: null, pullRequestUrl: null } })],
        }),
      );

      expect(result.intent).toBe('hold');
    });

    it('holds a QUARANTINED issue, even one a human just cleared', () => {
      // The strongest form of the precedence rule: hold outranks even an
      // explicit human release, because the human may have applied hold second
      // and changed their mind.
      const result = project(
        observed({
          issues: [
            issue({
              inputLabels: [INPUT_LABELS.HOLD, INPUT_LABELS.CLEAR_QUARANTINE],
            }),
          ],
          workOrders: [workOrder({ status: 'quarantined' })],
          humanClearedQuarantine: new Set([312]),
        }),
      );

      expect(result.intent).toBe('hold');
    });

    it('wants no mirror labels while held', () => {
      const result = project(
        observed({ issues: [issue({ inputLabels: [INPUT_LABELS.HOLD] })] }),
      );

      expect(result.desiredMirrorLabels).toEqual([]);
    });

    it('stops holding the moment the label is removed', () => {
      // #49: "Removing an input label is honoured as promptly as adding one."
      // Trivially true here BECAUSE the projection is recomputed from scratch
      // — which is the property being asserted.
      const result = project(
        observed({ issues: [issue({ inputLabels: [INPUT_LABELS.READY] })] }),
      );

      expect(result.intent).toBe('dispatch');
    });
  });

  describe('quarantine', () => {
    it('stays quarantined without the label', () => {
      const result = project(
        observed({ workOrders: [workOrder({ status: 'quarantined' })] }),
      );

      expect(result.intent).toBe('quarantined');
      expect(result.desiredMirrorLabels).toEqual([MIRROR_LABELS.QUARANTINE]);
    });

    it('REFUSES to clear when the label is present but no human applied it', () => {
      // VISION §8's never-trustable rule. An agent that can apply the label to
      // release itself has the appearance of a guardrail and none of the
      // substance — so presence of the label is explicitly not enough.
      const result = project(
        observed({
          issues: [issue({ inputLabels: [INPUT_LABELS.CLEAR_QUARANTINE] })],
          workOrders: [workOrder({ status: 'quarantined' })],
          humanClearedQuarantine: new Set(),
        }),
      );

      expect(result.intent).toBe('quarantined');
      // The refusal is reported, not silent — #49 requires it be "rejected and
      // reported", and a silent refusal looks identical to a bug.
      expect(result.reason).toContain('no human applied it');
    });

    it('clears when a human applied the label', () => {
      const result = project(
        observed({
          issues: [issue({ inputLabels: [INPUT_LABELS.CLEAR_QUARANTINE] })],
          workOrders: [workOrder({ status: 'quarantined' })],
          humanClearedQuarantine: new Set([312]),
        }),
      );

      expect(result.intent).toBe('dispatch');
      expect(result.reason).toContain('cleared by a human');
    });
  });

  describe('live run state', () => {
    function withRun(status: RunStatusLike, extra: Record<string, unknown> = {}) {
      return observed({
        issues: [issue({ inputLabels: [INPUT_LABELS.READY] })],
        workOrders: [
          workOrder({
            run: { id: 'r', status, costUsd: null, pullRequestUrl: null, ...extra },
          }),
        ],
      });
    }

    it('leaves a running run alone even when ready is set', () => {
      const result = project(withRun('running'));

      expect(result.intent).toBe('running');
      expect(result.desiredMirrorLabels).toEqual([MIRROR_LABELS.DISPATCHED]);
    });

    it('treats a stalled run as still live, not as a dispatch candidate', () => {
      // A stalled run has not been killed yet. Dispatching a second run
      // alongside it would put two runners on one branch.
      expect(project(withRun('stalled')).intent).toBe('running');
    });

    it('marks a blocked run blocked, and says it needs no human', () => {
      const result = project(withRun('blocked'));

      expect(result.intent).toBe('blocked');
      expect(result.reason).toContain('without a human');
      expect(result.desiredMirrorLabels).toEqual([MIRROR_LABELS.BLOCKED]);
    });

    it('marks a succeeded run with a PR as awaiting review', () => {
      const result = project(withRun('succeeded', { pullRequestUrl: 'https://x/pull/9' }));

      expect(result.intent).toBe('review');
      expect(result.desiredMirrorLabels).toEqual([MIRROR_LABELS.REVIEW]);
    });

    it('re-dispatches a succeeded run that opened NO pull request', () => {
      // Succeeded-but-no-PR is not review-ready; it is a run that produced
      // nothing to review, so `factory:ready` should pick it up again.
      expect(project(withRun('succeeded')).intent).toBe('dispatch');
    });

    it('re-dispatches after a failed run', () => {
      expect(project(withRun('failed')).intent).toBe('dispatch');
    });
  });

  describe('dispatch authorization', () => {
    it('requires factory:ready', () => {
      const result = project(observed());

      expect(result.intent).toBe('ignore');
      expect(result.reason).toContain(`no ${INPUT_LABELS.READY}`);
    });

    it('does not dispatch when the repository has dispatch disabled', () => {
      // VISION §12's observation week ends one repository at a time.
      const state = observed({ issues: [issue({ inputLabels: [INPUT_LABELS.READY] })] });
      state.repository.dispatchEnabled = false;

      const result = project(state);

      expect(result.intent).toBe('ignore');
      expect(result.reason).toContain('dispatch is disabled');
    });

    it('distinguishes "ignored" from "held" in its reason', () => {
      // Both produce no dispatch and they mean opposite things: one is a
      // human's brake, the other is an issue that was never a candidate.
      const ignored = project(observed());
      const held = project(observed({ issues: [issue({ inputLabels: [INPUT_LABELS.HOLD] })] }));

      expect(ignored.intent).not.toBe(held.intent);
    });
  });

  describe('budget', () => {
    function withSpend(costUsd: number | null, ceiling: number | null) {
      const state = observed({
        issues: [issue({ inputLabels: [INPUT_LABELS.READY] })],
        workOrders: [
          workOrder({ run: { id: 'r', status: 'failed', costUsd, pullRequestUrl: null } }),
        ],
      });
      state.repository.budgetCeilingUsd = ceiling;
      return state;
    }

    it('quarantines at the ceiling rather than dispatching again', () => {
      const result = project(withSpend(5, 5));

      expect(result.intent).toBe('quarantined');
      expect(result.reason).toContain('ceiling');
    });

    it('dispatches below the ceiling', () => {
      expect(project(withSpend(2, 5)).intent).toBe('dispatch');
    });

    it('does not treat an UNKNOWN spend as zero', () => {
      // VISION §6 makes cost reporting a declared capability, so null and 0
      // are different. Treating unknown as zero would silently pass a budget
      // check for a runner that never reports cost.
      const result = project(withSpend(null, 5));

      expect(result.intent).toBe('dispatch');
      expect(result.reason).not.toContain('ceiling');
    });

    it('ignores spend when no ceiling is set', () => {
      expect(project(withSpend(1000, null)).intent).toBe('dispatch');
    });
  });

  describe('work-order selection', () => {
    it('uses the latest attempt', () => {
      const result = project(
        observed({
          workOrders: [
            workOrder({ identity: 'a1', attempt: 1, status: 'superseded' }),
            workOrder({
              identity: 'a2',
              attempt: 2,
              run: { id: 'r', status: 'running', costUsd: null, pullRequestUrl: null },
            }),
          ],
        }),
      );

      expect(result.reason).toContain('a2');
    });

    it('ignores superseded and cancelled work orders entirely', () => {
      // Abandon-and-re-run (VISION §3.4) leaves earlier attempts in place.
      // They are countable history, not current state.
      const result = project(
        observed({
          issues: [issue({ inputLabels: [INPUT_LABELS.READY] })],
          workOrders: [
            workOrder({
              attempt: 1,
              status: 'superseded',
              run: { id: 'r', status: 'running', costUsd: null, pullRequestUrl: null },
            }),
          ],
        }),
      );

      expect(result.intent).toBe('dispatch');
      expect(result.reason).toContain('no work order exists yet');
    });
  });

  describe('the properties #46 requires', () => {
    it('is deterministic: identical inputs give an identical projection', () => {
      const state = observed({
        issues: [
          issue({ number: 1, inputLabels: [INPUT_LABELS.READY] }),
          issue({ number: 2, inputLabels: [INPUT_LABELS.HOLD] }),
          issue({ number: 3 }),
        ],
      });

      expect(projectDesiredState(state)).toEqual(projectDesiredState(state));
    });

    it('is serializable, so it can be logged and diffed across ticks', () => {
      const projected = projectDesiredState(
        observed({ issues: [issue({ inputLabels: [INPUT_LABELS.READY] })] }),
      );

      expect(JSON.parse(JSON.stringify(projected))).toEqual(projected);
    });

    it('does not mutate its input', () => {
      // A projection that edited observed state would make "recompute from
      // scratch" false on the second call within one tick.
      const state = observed({ issues: [issue({ inputLabels: [INPUT_LABELS.READY] })] });
      const before = JSON.stringify(state, (_k, v) => (v instanceof Set ? [...v] : v));

      projectDesiredState(state);

      expect(JSON.stringify(state, (_k, v) => (v instanceof Set ? [...v] : v))).toBe(before);
    });

    it('reflects a manual edit on the very next call, with no reset', () => {
      // The reconciler-vs-queue property from VISION §4. A queue would need to
      // be told; the projection simply reads the new input.
      const before = project(observed({ issues: [issue({ inputLabels: [INPUT_LABELS.READY] })] }));
      const after = project(
        observed({ issues: [issue({ inputLabels: [INPUT_LABELS.READY, INPUT_LABELS.HOLD] })] }),
      );

      expect(before.intent).toBe('dispatch');
      expect(after.intent).toBe('hold');
    });

    it('gives every issue a reason, including the ignored ones', () => {
      // "Why is Opifex doing nothing about #312" is the question the
      // observation week most needs answered, and an ignored issue produces
      // no action to carry a reason.
      const projected = projectDesiredState(
        observed({ issues: [issue({ number: 1 }), issue({ number: 2 })] }),
      );

      for (const state of projected.issues) {
        expect(state.reason.length).toBeGreaterThan(0);
      }
    });
  });

  describe('mirror labels are inert', () => {
    it('ignores observedMirrorLabels entirely', () => {
      // The field exists for the DIFF ENGINE, which must know what is
      // currently written in order to avoid redundant writes and remove stale
      // labels. The projection must never see it: letting it in would make
      // what SHOULD be true depend on Opifex's own previous output, so a
      // failed mirror write or a human hand-edit would roll the control
      // plane's state backwards.
      const clean = project(observed({ issues: [issue({ inputLabels: [INPUT_LABELS.READY] })] }));
      const dirty = project(
        observed({
          issues: [
            issue({
              inputLabels: [INPUT_LABELS.READY],
              observedMirrorLabels: [
                MIRROR_LABELS.QUARANTINE,
                MIRROR_LABELS.BLOCKED,
                MIRROR_LABELS.DISPATCHED,
              ],
            }),
          ],
        }),
      );

      expect(dirty).toEqual(clean);
    });

    it('produces the same projection whether or not mirror labels are present', () => {
      // VISION §3.3. The read adapter strips them, but if one ever reached the
      // projection it must change nothing — otherwise Opifex reads its own
      // output as input and the state machine has moved into issue labels.
      const withoutMirror = project(
        observed({ issues: [issue({ inputLabels: [INPUT_LABELS.READY] })] }),
      );
      const withMirror = project(
        observed({
          issues: [
            issue({
              inputLabels: [INPUT_LABELS.READY],
              labels: [
                { name: MIRROR_LABELS.DISPATCHED, color: 'ededed', description: null },
                { name: MIRROR_LABELS.QUARANTINE, color: 'ededed', description: null },
              ],
            }),
          ],
        }),
      );

      expect(withMirror).toEqual(withoutMirror);
    });
  });

  describe('assertNoMirrorLabelsObserved', () => {
    it('passes for issues the read adapter already filtered', () => {
      expect(() => assertNoMirrorLabelsObserved([issue()])).not.toThrow();
    });

    it('throws loudly if a mirror label ever reaches the projection', () => {
      expect(() =>
        assertNoMirrorLabelsObserved([
          issue({
            labels: [{ name: MIRROR_LABELS.DISPATCHED, color: 'ededed', description: null }],
          }),
        ]),
      ).toThrow(/VISION §3.3/);
    });
  });
});

describe('the decoupled enums', () => {
  /**
   * `desired-state.types.ts` restates the Prisma enums as string unions so a
   * fixture can be built without a database in scope. That decoupling is only
   * safe while the two agree, and nothing else would notice them drifting —
   * a status added to the schema would simply never be projected.
   */
  it('matches Prisma WorkOrderStatus exactly', async () => {
    const { WorkOrderStatus } = await import('@prisma/client');
    const local: WorkOrderStatusLike[] = [
      'pending', 'queued', 'held', 'dispatched', 'succeeded',
      'failed', 'quarantined', 'superseded', 'cancelled',
    ];

    expect(Object.values(WorkOrderStatus).sort()).toEqual([...local].sort());
  });

  it('matches Prisma RunStatus exactly', async () => {
    const { RunStatus } = await import('@prisma/client');
    const local: RunStatusLike[] = [
      'running', 'succeeded', 'stalled', 'blocked', 'failed', 'quarantined',
    ];

    expect(Object.values(RunStatus).sort()).toEqual([...local].sort());
  });
});
