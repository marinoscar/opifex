import { fromMirrorLabels, fromSpecFeedback } from './execution-failures';
import type { ExecutionOutcome } from './mirror-label.executor';
import type { SpecFeedbackOutcome } from './spec-feedback.executor';
import type { ReconcileAction } from '../diff/actions.types';

/**
 * #320's normalization layer: the two executors report failures in the shape
 * each has to hand, and this is the only place either shape is turned into
 * the one `reconcile_ticks.execution_failures` actually stores.
 */
describe('execution-failures normalization (#320)', () => {
  function outcome(
    failures: ExecutionOutcome['failures'] = [],
  ): ExecutionOutcome {
    return { executed: 0, noops: 0, suppressed: 0, failures };
  }

  const ADD_LABEL_ACTION = {
    type: 'add-mirror-label',
    repository: 'acme/app',
    issueNumber: 312,
    label: 'factory/dispatched',
    reason: 'mirror label factory/dispatched should be present',
    evidence: {
      intent: 'dispatch',
      inputLabels: ['factory:ready'],
      workOrderIdentity: null,
      runStatus: null,
      currentMirrorLabels: [],
      desiredMirrorLabels: ['factory/dispatched'],
    },
  } as unknown as ReconcileAction;

  describe('fromMirrorLabels', () => {
    it('returns an empty array when nothing failed', () => {
      expect(fromMirrorLabels(outcome())).toEqual([]);
    });

    it('normalizes a real GitHub failure, carrying the action type, repository and issue', () => {
      const result = fromMirrorLabels(
        outcome([{ action: ADD_LABEL_ACTION, reason: 'GitHub said 403' }]),
      );

      expect(result).toEqual([
        {
          source: 'mirror-label',
          actionType: 'add-mirror-label',
          repository: 'acme/app',
          issueNumber: 312,
          reason: 'GitHub said 403',
        },
      ]);
    });

    // The non-GitHub case, and the reason the column is not named
    // `write_failures`: `MirrorLabelExecutor` pushes an entry here for an
    // action with no label at all, which is a diff-engine bug it cannot tell
    // apart from a refused write from where it stands. Normalization must
    // carry that reason through verbatim rather than paper over it.
    it('normalizes a diff-engine bug the same way as a GitHub failure — the reason says which', () => {
      const buggyAction = {
        ...ADD_LABEL_ACTION,
        label: undefined,
      } as unknown as ReconcileAction;

      const result = fromMirrorLabels(
        outcome([
          { action: buggyAction, reason: 'label action carried no label' },
        ]),
      );

      expect(result).toEqual([
        {
          source: 'mirror-label',
          actionType: 'add-mirror-label',
          repository: 'acme/app',
          issueNumber: 312,
          reason: 'label action carried no label',
        },
      ]);
    });

    it('preserves order across multiple failures', () => {
      const second = { ...ADD_LABEL_ACTION, issueNumber: 400 };
      const result = fromMirrorLabels(
        outcome([
          { action: ADD_LABEL_ACTION, reason: 'first' },
          { action: second, reason: 'second' },
        ]),
      );

      expect(result.map((f) => f.reason)).toEqual(['first', 'second']);
      expect(result.map((f) => f.issueNumber)).toEqual([312, 400]);
    });
  });

  describe('fromSpecFeedback', () => {
    function specOutcome(
      failures: SpecFeedbackOutcome['failures'] = [],
    ): SpecFeedbackOutcome {
      return { posted: 0, alreadyTold: 0, suppressed: 0, failures };
    }

    it('returns an empty array when nothing failed', () => {
      expect(fromSpecFeedback(specOutcome())).toEqual([]);
    });

    // `actionType` is the synthetic `post-spec-feedback`: this executor acts
    // on a rejection, which by definition never became a computed action, so
    // there is no `ReconcileAction['type']` to report instead.
    it('normalizes a failure with the synthetic actionType post-spec-feedback', () => {
      const result = fromSpecFeedback(
        specOutcome([
          {
            issueNumber: 312,
            repository: 'acme/app',
            reason: '502 from GitHub',
          },
        ]),
      );

      expect(result).toEqual([
        {
          source: 'spec-feedback',
          actionType: 'post-spec-feedback',
          repository: 'acme/app',
          issueNumber: 312,
          reason: '502 from GitHub',
        },
      ]);
    });

    it('preserves order across multiple failures', () => {
      const result = fromSpecFeedback(
        specOutcome([
          { issueNumber: 1, repository: 'acme/one', reason: 'first' },
          { issueNumber: 2, repository: 'acme/two', reason: 'second' },
        ]),
      );

      expect(result.map((f) => f.reason)).toEqual(['first', 'second']);
    });
  });
});
