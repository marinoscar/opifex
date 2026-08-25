import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

import { DeadTimeService } from '../dead-time/dead-time.service';
import { DispatchQueueService } from '../dispatch/dispatch-queue.service';
import { EscalationsService } from '../escalations/escalations.service';
import { GitHubWriteService } from '../github/write/github-write.service';
import { GitLivenessService } from '../liveness/git-liveness.service';
import { EscalationDispatcher } from '../notifications/escalation-dispatcher.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { WatchdogService } from '../watchdog/watchdog.service';
import { MirrorLabelExecutor } from './execute/mirror-label.executor';
import { SpecFeedbackExecutor } from './execute/spec-feedback.executor';
import { ReconcileLogService } from './log/reconcile-log.service';
import { ReconcilerService } from './reconciler.service';
import { ReconcilerTask } from './reconciler.task';
import type { TickRecord, TickRejection } from './reconciler.types';

/**
 * The task is where computing meets acting, and the only thing worth testing
 * here is the ORDER and the GATES — which outward step happens, and behind
 * what.
 *
 * The step most likely to regress silently is spec feedback: it sits before
 * the `actions.length === 0` early return, and moving it after would silence
 * feedback in exactly the repository where nothing else is happening. That is
 * a change nothing else would catch.
 */
describe('ReconcilerTask', () => {
  const REJECTION: TickRejection = {
    issueNumber: 312,
    problems: [],
    message: '`TBD` is not a testable acceptance criterion.',
    bodyDigest: 'digest-v1',
    repository: { id: 'repo-uuid', owner: 'acme', name: 'app' },
    feedbackEnabled: true,
  };

  function tickRecord(overrides: Partial<TickRecord> = {}): TickRecord {
    return {
      id: 'tick-uuid',
      startedAt: new Date('2026-08-23T02:00:00Z'),
      finishedAt: new Date('2026-08-23T02:00:01Z'),
      durationMs: 1000,
      outcome: 'completed',
      repositoriesObserved: 1,
      failures: [],
      allFromCache: false,
      rateLimitRemaining: 4999,
      projections: [],
      workOrdersCreated: 0,
      rejections: [],
      actions: [],
      ...overrides,
    };
  }

  let tick: jest.Mock;
  let report: jest.Mock;
  let execute: jest.Mock;
  let drain: jest.Mock;
  let listObserved: jest.Mock;
  let recordDeadTime: jest.Mock;
  let recordExecution: jest.Mock;
  /** Stands in for the write service's monotonic issued-writes counter. */
  let writesIssued: number;
  let task: ReconcilerTask;

  /** `runOnce` is private and is what the interval calls. */
  const run = () => (task as unknown as { runOnce(): Promise<void> }).runOnce();

  beforeEach(() => {
    tick = jest.fn().mockResolvedValue(tickRecord());
    report = jest.fn().mockResolvedValue({
      posted: 0,
      alreadyTold: 0,
      suppressed: 0,
      failures: [],
    });
    execute = jest.fn().mockResolvedValue({
      executed: 0,
      noops: 0,
      suppressed: 0,
      failures: [],
    });
    drain = jest.fn().mockResolvedValue({
      dispatched: 0,
      stillQueued: 0,
      observed: 0,
      failed: 0,
      unrebuildable: 0,
      repositoriesDisabled: 0,
    });
    listObserved = jest.fn().mockResolvedValue([]);
    recordDeadTime = jest.fn().mockResolvedValue({
      opened: 0,
      resumed: 0,
      concluded: 0,
      quarantined: 0,
      open: 0,
    });
    recordExecution = jest.fn().mockResolvedValue(undefined);
    writesIssued = 0;

    task = new ReconcilerTask(
      { get: () => undefined } as unknown as ConfigService,
      {
        addInterval: jest.fn(),
        doesExist: jest.fn(),
        deleteInterval: jest.fn(),
      } as unknown as SchedulerRegistry,
      { tick } as unknown as ReconcilerService,
      { execute } as unknown as MirrorLabelExecutor,
      { report } as unknown as SpecFeedbackExecutor,
      { drain } as unknown as DispatchQueueService,
      { listObserved } as unknown as RepositoriesService,
      {
        sweep: jest.fn().mockResolvedValue({
          runsWatched: 0,
          eventsRecorded: 0,
          disagreements: [],
        }),
      } as unknown as GitLivenessService,
      {
        sweep: jest.fn().mockResolvedValue({
          runsJudged: 0,
          judgedRunIds: [],
          actions: [],
          silentRuns: 0,
          loopingRuns: 0,
          loopCheckUnavailable: 0,
          parkedRuns: 0,
          resumableRuns: 0,
          deadObservations: [],
        }),
      } as unknown as WatchdogService,
      {
        record: recordDeadTime,
      } as unknown as DeadTimeService,
      {
        raiseFrom: jest.fn().mockResolvedValue({ raised: 0, deduplicated: 0 }),
        resolveStale: jest.fn().mockResolvedValue(0),
      } as unknown as EscalationsService,
      {
        dispatchPending: jest.fn().mockResolvedValue({
          dispatched: 0,
          rerouted: 0,
          retried: 0,
          failed: 0,
          timedOut: 0,
          abandoned: 0,
        }),
      } as unknown as EscalationDispatcher,
      {
        get writesIssued() {
          return writesIssued;
        },
      } as unknown as GitHubWriteService,
      { recordExecution } as unknown as ReconcileLogService,
    );
  });

  describe('the dispatch queue', () => {
    it('is drained on a tick that computed no actions at all', async () => {
      // A queued work order produces no ACTION — the diff engine's actions are
      // about issues. Gating dispatch on the action list would mean the queue
      // never drains on a quiet tick, which is most of them.
      await run();

      expect(drain).toHaveBeenCalledTimes(1);
    });

    it('is drained even when no repository has mirror labels enabled', async () => {
      // Dispatch is behind its own gates, not the label flag.
      listObserved.mockResolvedValue([]);

      await run();

      expect(drain).toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

    it('is drained AFTER the tick, so this tick can dispatch what it projected', async () => {
      const order: string[] = [];
      tick.mockImplementation(async () => {
        order.push('tick');
        return tickRecord();
      });
      drain.mockImplementation(async () => {
        order.push('drain');
        return {
          dispatched: 0,
          stillQueued: 0,
          observed: 0,
          failed: 0,
          unrebuildable: 0,
          repositoriesDisabled: 0,
        };
      });

      await run();

      expect(order).toEqual(['tick', 'drain']);
    });

    it('does not stop the tick when draining throws', async () => {
      drain.mockRejectedValue(new Error('database gone'));

      await expect(run()).resolves.toBeUndefined();
    });
  });

  describe('spec feedback', () => {
    it('is reported on a tick that computed no actions at all', async () => {
      // The load-bearing assertion. A rejected issue never became a work
      // order, so it produces NO action — gating this on the action list
      // would silence feedback in the one repository where nothing else is
      // happening, which is precisely where somebody is waiting to hear back.
      tick.mockResolvedValue(
        tickRecord({ rejections: [REJECTION], actions: [] }),
      );

      await run();

      expect(report).toHaveBeenCalledWith([REJECTION]);
    });

    it('is not called when there is nothing to report', async () => {
      await run();

      expect(report).not.toHaveBeenCalled();
    });

    it('does not stop the tick when reporting throws', async () => {
      // A GitHub outage while commenting must not take down the loop that
      // would notice the next problem.
      tick.mockResolvedValue(tickRecord({ rejections: [REJECTION] }));
      report.mockRejectedValue(new Error('502 from GitHub'));

      await expect(run()).resolves.toBeUndefined();
    });

    it('runs it even when no repository has mirror labels enabled', async () => {
      // Spec feedback is behind its OWN flag. Sharing the label gate would
      // mean an operator who wants status labels gets prose they never asked
      // for, and one who wants feedback has to accept labels to get it.
      tick.mockResolvedValue(
        tickRecord({ rejections: [REJECTION], actions: [] }),
      );
      listObserved.mockResolvedValue([]);

      await run();

      expect(report).toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });
  });

  /**
   * #317: `actionsExecuted` was a literal `0`, so the observation week's one
   * safety check — "it must be 0 on every tick, all week" — could not fail.
   *
   * What is worth pinning here is that the figure comes from the WRITE
   * SERVICE and not from the executors. A sum of what the executors return
   * counts mirror labels and spec-feedback comments and silently misses the
   * authorization record and branch a dispatch writes, which is the same bug
   * one layer down.
   */
  describe('recording what the tick executed', () => {
    it('records nothing when no write left the process', async () => {
      // The observation-week case, which is every tick of it: the kill switch
      // is off, so the counter never moves and the row's opening 0 is already
      // right. No second database write at all.
      await run();

      expect(recordExecution).not.toHaveBeenCalled();
    });

    it('records the delta over the write service, against the tick row', async () => {
      execute.mockImplementation(async () => {
        writesIssued += 2;
        return { executed: 2, noops: 0, suppressed: 0, failures: [] };
      });
      listObserved.mockResolvedValue([
        { owner: 'acme', name: 'app', mirrorLabelsEnabled: true },
      ]);
      tick.mockResolvedValue(
        tickRecord({
          actions: [
            {
              type: 'add-mirror-label',
              repository: 'acme/app',
              issueNumber: 312,
            },
          ] as unknown as TickRecord['actions'],
        }),
      );

      await run();

      expect(recordExecution).toHaveBeenCalledWith(
        'tick-uuid',
        expect.objectContaining({ writesIssued: 2 }),
      );
    });

    it('counts writes made by DISPATCH, which returns no tally of its own', async () => {
      // The reason this is a delta over the choke point rather than a sum of
      // executor return values. A dispatch posts an authorization record and
      // creates a branch; nothing hands those counts back to the task.
      drain.mockImplementation(async () => {
        writesIssued += 2;
        return {
          dispatched: 1,
          stillQueued: 0,
          observed: 0,
          failed: 0,
          unrebuildable: 0,
          repositoriesDisabled: 0,
        };
      });

      await run();

      expect(recordExecution).toHaveBeenCalledWith(
        'tick-uuid',
        expect.objectContaining({ writesIssued: 2 }),
      );
    });

    it('records the writes even when the tick returned early', async () => {
      // A quiet tick returns before the label executor. Writes issued by
      // dispatch or spec feedback happened anyway, and must still be logged.
      tick.mockResolvedValue(tickRecord({ actions: [] }));
      drain.mockImplementation(async () => {
        writesIssued += 1;
        return {
          dispatched: 1,
          stillQueued: 0,
          observed: 0,
          failed: 0,
          unrebuildable: 0,
          repositoriesDisabled: 0,
        };
      });

      await run();

      expect(recordExecution).toHaveBeenCalledWith(
        'tick-uuid',
        expect.objectContaining({ writesIssued: 1 }),
      );
    });

    it('does not stop the tick when recording the count throws', async () => {
      drain.mockImplementation(async () => {
        writesIssued += 1;
        return {
          dispatched: 1,
          stillQueued: 0,
          observed: 0,
          failed: 0,
          unrebuildable: 0,
          repositoriesDisabled: 0,
        };
      });
      recordExecution.mockRejectedValue(new Error('disk full'));

      await expect(run()).resolves.toBeUndefined();
    });
  });

  /**
   * #320: the null/`[]` boundary on `executionFailures`, which is the whole
   * fix. `null` means no acting-phase executor ran at all this tick; `[]`
   * means one ran and reported nothing wrong. Flattening the two together —
   * writing `[]` whenever nothing failed, whether or not anything acted —
   * would turn "never tried" into a clean bill of health nobody earned.
   */
  describe('the null/[] boundary on executionFailures', () => {
    const ADD_LABEL_ACTION = {
      type: 'add-mirror-label',
      repository: 'acme/app',
      issueNumber: 312,
      label: 'factory/dispatched',
    };

    it('(a) records [] — not null — when an executor ran with rejections and no failures', async () => {
      // Spec feedback ran (it always answers when there is a rejection) and
      // reported nothing wrong: the acting phase HAS an answer, so the column
      // must say so with `[]`, not stay `null`.
      tick.mockResolvedValue(
        tickRecord({ rejections: [REJECTION], actions: [] }),
      );

      await run();

      expect(recordExecution).toHaveBeenCalledWith(
        'tick-uuid',
        expect.objectContaining({ executionFailures: [] }),
      );
    });

    it('(b) records null, not [], when neither executor ran even though dispatch issued writes', async () => {
      // Dispatch writes (branches, authorization records) move `writesIssued`
      // without either acting-phase executor ever being called. The column
      // must stay null: nothing here has an opinion on what dispatch did.
      drain.mockImplementation(async () => {
        writesIssued += 1;
        return {
          dispatched: 1,
          stillQueued: 0,
          observed: 0,
          failed: 0,
          unrebuildable: 0,
          repositoriesDisabled: 0,
        };
      });
      tick.mockResolvedValue(tickRecord({ actions: [], rejections: [] }));

      await run();

      expect(execute).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
      expect(recordExecution).toHaveBeenCalledWith('tick-uuid', {
        writesIssued: 1,
        executionFailures: null,
      });
    });

    it('(c) carries a mirror-label failure through normalized', async () => {
      listObserved.mockResolvedValue([
        { owner: 'acme', name: 'app', mirrorLabelsEnabled: true },
      ]);
      execute.mockResolvedValue({
        executed: 0,
        noops: 0,
        suppressed: 0,
        failures: [
          { action: ADD_LABEL_ACTION, reason: 'label action carried no label' },
        ],
      });
      tick.mockResolvedValue(
        tickRecord({
          actions: [ADD_LABEL_ACTION] as unknown as TickRecord['actions'],
        }),
      );

      await run();

      expect(recordExecution).toHaveBeenCalledWith(
        'tick-uuid',
        expect.objectContaining({
          executionFailures: [
            {
              source: 'mirror-label',
              actionType: 'add-mirror-label',
              repository: 'acme/app',
              issueNumber: 312,
              reason: 'label action carried no label',
            },
          ],
        }),
      );
    });

    it('(d) concatenates failures from BOTH executors into one array', async () => {
      listObserved.mockResolvedValue([
        { owner: 'acme', name: 'app', mirrorLabelsEnabled: true },
      ]);
      report.mockResolvedValue({
        posted: 0,
        alreadyTold: 0,
        suppressed: 0,
        failures: [
          {
            issueNumber: 312,
            repository: 'acme/app',
            reason: '502 from GitHub',
          },
        ],
      });
      execute.mockResolvedValue({
        executed: 0,
        noops: 0,
        suppressed: 0,
        failures: [{ action: ADD_LABEL_ACTION, reason: 'GitHub said 403' }],
      });
      tick.mockResolvedValue(
        tickRecord({
          rejections: [REJECTION],
          actions: [ADD_LABEL_ACTION] as unknown as TickRecord['actions'],
        }),
      );

      await run();

      expect(recordExecution).toHaveBeenCalledWith(
        'tick-uuid',
        expect.objectContaining({
          executionFailures: [
            {
              source: 'spec-feedback',
              actionType: 'post-spec-feedback',
              repository: 'acme/app',
              issueNumber: 312,
              reason: '502 from GitHub',
            },
            {
              source: 'mirror-label',
              actionType: 'add-mirror-label',
              repository: 'acme/app',
              issueNumber: 312,
              reason: 'GitHub said 403',
            },
          ],
        }),
      );
    });

    /**
     * (e) — the load-bearing case. The gate (`acting.ran`) must be set only
     * when `SpecFeedbackExecutor.report` RETURNS, not when it is CALLED. If a
     * refactor moved the flag to the point of the call, a thrown executor
     * would still report `acting.ran = true`, and a crash would be recorded
     * as `[]` — a clean bill of health nobody earned, on the exact tick that
     * most needs `null` to say "nothing here can be trusted".
     */
    it('(e) stays null — not [] — when specFeedback.report REJECTS outright', async () => {
      // A write issued elsewhere (dispatch) forces `recordExecution` past its
      // `issued === 0 && !acting.ran` early return, so what is asserted here
      // is squarely the gate on `executionFailures`, not whether the method
      // was called at all.
      drain.mockImplementation(async () => {
        writesIssued += 1;
        return {
          dispatched: 1,
          stillQueued: 0,
          observed: 0,
          failed: 0,
          unrebuildable: 0,
          repositoriesDisabled: 0,
        };
      });
      report.mockRejectedValue(new Error('GitHub outage'));
      tick.mockResolvedValue(
        tickRecord({ rejections: [REJECTION], actions: [] }),
      );

      await run();

      expect(report).toHaveBeenCalled();
      expect(recordExecution).toHaveBeenCalledWith('tick-uuid', {
        writesIssued: 1,
        executionFailures: null,
      });
    });
  });

  /**
   * #320: before this fix, `recordExecution` (then `recordWritesIssued`)
   * returned early whenever `issued === 0`, full stop — so a tick with
   * rejections and an acting phase that ran, but issued no GitHub write at
   * all, never stamped anything back onto its row. That is the behaviour
   * change most likely to surprise someone reading this code cold: the gate
   * is now `issued === 0 && !acting.ran`, not `issued === 0` alone.
   */
  it('stamps the row even when a tick with rejections issued zero writes', async () => {
    tick.mockResolvedValue(
      tickRecord({ rejections: [REJECTION], actions: [] }),
    );

    await run();

    expect(recordExecution).toHaveBeenCalledTimes(1);
    expect(recordExecution).toHaveBeenCalledWith('tick-uuid', {
      writesIssued: 0,
      executionFailures: [],
    });
  });
});
