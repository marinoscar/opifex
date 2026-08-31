import { RunExecutorService } from '../../dispatch/run-executor.service';
import type { ResumeResult } from '../../dispatch/run-executor.service';
import type {
  ReconcileAction,
  ReconcileActionType,
} from '../diff/actions.types';
import type {
  DesiredIssueState,
  DesiredState,
  IssueIntent,
} from '../projection/desired-state.types';
import { ResumeExecutor } from './resume.executor';

/**
 * `ResumeExecutor` (#477): the consumer of the `resume` action, and the one
 * place a `factory:hold` applied while a run is parked can still stop it.
 *
 * `RunExecutorService.resumeParkedRun` is always a double here — its own
 * gates (`ResumeRefusal`) are `run-executor.service.spec.ts`'s job. What is
 * under test in this file is entirely upstream of that call: which actions
 * reach it, which are refused on the projection's intent alone before it is
 * ever invoked, and how one action's failure does or does not affect the
 * ones behind it.
 */
describe('ResumeExecutor', () => {
  function action(overrides: Partial<ReconcileAction> = {}): ReconcileAction {
    return {
      type: 'resume',
      repository: 'acme/widgets',
      issueNumber: 42,
      runId: 'run-uuid-1',
      reason: 'its scheduled time has passed',
      evidence: {
        intent: 'blocked',
        inputLabels: [],
        workOrderIdentity: 'wo_acme-widgets_42_abc1234_a1',
        runStatus: 'blocked',
        currentMirrorLabels: [],
        desiredMirrorLabels: [],
      },
      ...overrides,
    };
  }

  function issueState(
    overrides: Partial<DesiredIssueState> = {},
  ): DesiredIssueState {
    return {
      issueNumber: 42,
      intent: 'blocked',
      reason: 'parked with a reset time',
      inputLabels: [],
      desiredMirrorLabels: [],
      ...overrides,
    };
  }

  function projections(
    repository: string,
    issues: DesiredIssueState[],
  ): DesiredState[] {
    return [{ repository, issues }];
  }

  let resumeParkedRun: jest.Mock;
  let executor: ResumeExecutor;

  beforeEach(() => {
    resumeParkedRun = jest.fn();
    executor = new ResumeExecutor({
      resumeParkedRun,
    } as unknown as RunExecutorService);
  });

  describe('what it will not touch', () => {
    it.each<ReconcileActionType>([
      'dispatch',
      'escalate',
      'quarantine',
      'release-quarantine',
      'hold',
      'add-mirror-label',
      'remove-mirror-label',
      'kill-and-re-run',
      'kill-and-re-plan',
    ])('ignores a %s action entirely', async (type) => {
      const outcome = await executor.execute(
        [action({ type })],
        projections('acme/widgets', [issueState()]),
      );

      expect(resumeParkedRun).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        resumed: 0,
        refused: 0,
        observed: 0,
        unobserved: 0,
        failures: [],
      });
    });

    it("counts a 'park' action nowhere -- it is persisted by the watchdog, not this executor", async () => {
      // `WatchdogSweepResult.parkedRuns` already reports this number from the
      // component that produced it. A second tally here would be a second
      // source of truth for one fact.
      const outcome = await executor.execute(
        [action({ type: 'park', resumeAt: '2026-08-23T18:00:00.000Z' })],
        projections('acme/widgets', [issueState()]),
      );

      expect(resumeParkedRun).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ resumed: 0, refused: 0, unobserved: 0 });
    });

    it('records a failure for a resume action with no runId, rather than throwing', async () => {
      const outcome = await executor.execute(
        [action({ runId: undefined })],
        projections('acme/widgets', [issueState()]),
      );

      expect(resumeParkedRun).not.toHaveBeenCalled();
      expect(outcome.failures).toHaveLength(1);
      expect(outcome.failures[0].reason).toContain('no runId');
    });
  });

  describe("the hold gate: resume only what THIS TICK's projection says is 'blocked'", () => {
    // The subtlety this file exists to pin: `HOLDABLE_STATUSES` excludes
    // `dispatched`, so a `factory:hold` applied to an issue whose run is
    // parked NEVER reaches the database — it lives only on the issue, and
    // only the from-scratch projection reads issues. A test that seeded a
    // hold on the `WorkOrder` row and expected a refusal would pass for the
    // wrong reason: this executor never queries the database for a hold at
    // all. So every case below is expressed purely through `intent`, with
    // no run/work-order row constructed, to prove the gate really is the
    // projection and not some database state a seed happened to also set.
    it.each<IssueIntent>([
      'hold',
      'quarantined',
      'ignore',
      'dispatch',
      'running',
      'review',
      'awaiting-checks',
    ])(
      "refuses when this tick's intent for the issue is '%s', without calling the executor",
      async (intent) => {
        const outcome = await executor.execute(
          [action()],
          projections('acme/widgets', [issueState({ intent })]),
        );

        expect(resumeParkedRun).not.toHaveBeenCalled();
        expect(outcome.refused).toBe(1);
      },
    );

    it("resumes when this tick's intent is 'blocked'", async () => {
      resumeParkedRun.mockResolvedValue({
        outcome: 'resumed',
        runId: 'run-uuid-1',
        runnerKey: 'claude-code-local',
        attempt: 2,
        reason: 'resumed',
      } satisfies ResumeResult);

      const outcome = await executor.execute(
        [action()],
        projections('acme/widgets', [issueState({ intent: 'blocked' })]),
      );

      expect(resumeParkedRun).toHaveBeenCalledWith('run-uuid-1');
      expect(outcome.resumed).toBe(1);
    });
  });

  describe('fail-closed on an unobserved issue (#477)', () => {
    it('does not resume, and is counted separately from a refusal, when this tick has no projection for the issue', async () => {
      // A repository that failed to observe, or an issue outside what was
      // fetched: nobody can say whether a hold applies, so the run stays
      // parked rather than guessing.
      const outcome = await executor.execute(
        [action()],
        projections('acme/widgets', []),
      );

      expect(resumeParkedRun).not.toHaveBeenCalled();
      expect(outcome.unobserved).toBe(1);
      expect(outcome.refused).toBe(0);
    });

    it('is unobserved when the action names a repository no projection covers at all', async () => {
      const outcome = await executor.execute(
        [action({ repository: 'acme/other' })],
        projections('acme/widgets', [issueState()]),
      );

      expect(resumeParkedRun).not.toHaveBeenCalled();
      expect(outcome.unobserved).toBe(1);
    });
  });

  describe('mapping RunExecutorService.resumeParkedRun outcomes onto the tally', () => {
    it('counts a refused resume as refused, not as a failure', async () => {
      resumeParkedRun.mockResolvedValue({
        outcome: 'refused',
        refusal: 'repository-budget-reached',
        reason: 'over budget',
      } satisfies ResumeResult);

      const outcome = await executor.execute(
        [action()],
        projections('acme/widgets', [issueState()]),
      );

      expect(outcome.refused).toBe(1);
      expect(outcome.failures).toHaveLength(0);
    });

    it("counts 'observed' as observed -- dispatch.enabled is off but the whole decision still ran", async () => {
      resumeParkedRun.mockResolvedValue({
        outcome: 'observed',
        reason: 'DISPATCH DISABLED — would have resumed it',
      } satisfies ResumeResult);

      const outcome = await executor.execute(
        [action()],
        projections('acme/widgets', [issueState()]),
      );

      expect(outcome.observed).toBe(1);
      expect(outcome.resumed).toBe(0);
    });

    it('records a failed resume as a failure, carrying the reason onto the tick', async () => {
      resumeParkedRun.mockResolvedValue({
        outcome: 'failed',
        runId: 'run-uuid-1',
        reason: 'could not start claude',
      } satisfies ResumeResult);

      const outcome = await executor.execute(
        [action()],
        projections('acme/widgets', [issueState()]),
      );

      expect(outcome.failures).toEqual([
        expect.objectContaining({ reason: 'could not start claude' }),
      ]);
      expect(outcome.resumed).toBe(0);
    });

    it('catches a rejected promise, so one parked run cannot abandon the ones behind it', async () => {
      resumeParkedRun
        .mockRejectedValueOnce(new Error('database is down'))
        .mockResolvedValueOnce({
          outcome: 'resumed',
          runId: 'run-uuid-2',
          runnerKey: 'claude-code-local',
          attempt: 2,
          reason: 'resumed',
        } satisfies ResumeResult);

      const outcome = await executor.execute(
        [
          action({ runId: 'run-uuid-1' }),
          action({ runId: 'run-uuid-2', issueNumber: 43 }),
        ],
        projections('acme/widgets', [
          issueState({ issueNumber: 42 }),
          issueState({ issueNumber: 43 }),
        ]),
      );

      expect(outcome.failures).toEqual([
        expect.objectContaining({ reason: 'database is down' }),
      ]);
      expect(outcome.resumed).toBe(1);
    });
  });

  describe('a fleet with several parked runs across repositories', () => {
    it('resolves each action against ITS OWN repository and issue number', async () => {
      resumeParkedRun.mockResolvedValue({
        outcome: 'resumed',
        runId: 'run-uuid-1',
        runnerKey: 'claude-code-local',
        attempt: 2,
        reason: 'resumed',
      } satisfies ResumeResult);

      const outcome = await executor.execute(
        [
          action({ repository: 'acme/widgets', issueNumber: 42 }),
          action({
            repository: 'acme/other',
            issueNumber: 42, // same issue NUMBER, different repository
            runId: 'run-uuid-2',
          }),
        ],
        [
          {
            repository: 'acme/widgets',
            issues: [issueState({ intent: 'blocked' })],
          },
          {
            repository: 'acme/other',
            issues: [issueState({ intent: 'hold' })],
          },
        ],
      );

      expect(resumeParkedRun).toHaveBeenCalledTimes(1);
      expect(resumeParkedRun).toHaveBeenCalledWith('run-uuid-1');
      expect(outcome.resumed).toBe(1);
      expect(outcome.refused).toBe(1);
    });
  });
});
