import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import { DeadTimeService } from '../dead-time/dead-time.service';
import { DispatchQueueService } from '../dispatch/dispatch-queue.service';
import { EscalationsService } from '../escalations/escalations.service';
import { GitHubWriteService } from '../github/write/github-write.service';
import { GitLivenessService } from '../liveness/git-liveness.service';
import { EscalationDispatcher } from '../notifications/escalation-dispatcher.service';
import { RepositoriesService } from '../repositories/repositories.service';
import {
  makeOperatorSettings,
  type FakeOperatorSettingsService,
} from '../settings/operator-settings/operator-settings.test-double';
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
  let settings: FakeOperatorSettingsService;
  let addInterval: jest.Mock;
  let deleteInterval: jest.Mock;
  let doesExist: jest.Mock;
  /**
   * What the registry currently holds, keyed by name.
   *
   * A real map rather than bare spies, because the two properties #343 has to
   * hold are properties of the REGISTRY, not of the call counts:
   * `SchedulerRegistry.addInterval` throws on a duplicate name and
   * `deleteInterval` throws on a name it does not hold, so spies that accepted
   * anything would let a double registration — the exact bug the mutex exists
   * to prevent — pass silently. Clearing the timers also keeps an interval
   * from holding Jest's event loop open and turning a pass into a hang.
   */
  let registered: Map<string, NodeJS.Timeout>;

  /** `runOnce` is private and is what the interval calls. */
  const run = () => (task as unknown as { runOnce(): Promise<void> }).runOnce();

  /**
   * Let a tick the fake clock just started get as far as it can.
   *
   * `advanceTimersByTime` is synchronous and the interval callback is not: it
   * awaits the liveness sweep and the watchdog before it ever reaches
   * `tick()`. Without draining the microtask queue, an assertion made straight
   * after advancing the clock is asserting about a tick that has not begun —
   * which passes for the wrong reason on `not.toHaveBeenCalled` and fails for
   * the wrong reason on everything else.
   */
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  /**
   * Construct the task against the CURRENT `settings` double.
   *
   * Extracted so a spec that needs a different enablement or period can
   * replace `settings` and rebuild, rather than reaching into a task that
   * has already read them.
   */
  function rebuild(): ReconcilerTask {
    return new ReconcilerTask(
      settings,
      {
        addInterval,
        doesExist,
        deleteInterval,
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
  }

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

    registered = new Map();
    addInterval = jest.fn((name: string, handle: NodeJS.Timeout) => {
      if (registered.has(name)) {
        throw new Error(
          `Interval with the given name (${name}) already exists`,
        );
      }
      registered.set(name, handle);
    });
    deleteInterval = jest.fn((name: string) => {
      const handle = registered.get(name);
      if (!handle) throw new Error(`No interval was found with the given name`);
      clearInterval(handle);
      registered.delete(name);
    });
    doesExist = jest.fn((_type: string, name: string) => registered.has(name));

    // ON, deliberately and out loud. `reconciler.enabled` defaults to FALSE in
    // the registry, and since #343 moved the gate into `runOnce` every
    // assertion in this file about what a tick does would otherwise pass by
    // proving that nothing happened.
    settings = makeOperatorSettings({
      overrides: { 'reconciler.enabled': true },
    });

    task = rebuild();
  });

  afterEach(() => {
    for (const handle of registered.values()) clearInterval(handle);
    registered.clear();
    jest.useRealTimers();
  });

  describe('registering the interval', () => {
    it('registers it even when the reconciler is disabled', async () => {
      // #343. The old shape registered NOTHING when the flag was off, which
      // made the interval's existence a second copy of the enablement state —
      // one `onModuleInit` runs too early to ever revise, so a flip had
      // nothing to turn on until somebody restarted the process.
      settings = makeOperatorSettings({
        overrides: { 'reconciler.enabled': false },
      });
      const disabled = rebuild();

      disabled.onModuleInit();

      expect(registered.has('reconciler-tick')).toBe(true);
    });

    it('registers at the configured period, not at a hardcoded one', async () => {
      jest.useFakeTimers();
      settings.setOverride('reconciler.intervalMs', 45_000);
      // Built after the override so the task reads 45s at `onModuleInit` and
      // this asserts about the FIRST registration rather than a
      // re-registration.
      const built = rebuild();
      built.onModuleInit();

      jest.advanceTimersByTime(44_999);
      await flush();
      expect(tick).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      await flush();
      expect(tick).toHaveBeenCalledTimes(1);
    });

    it.each([
      [true, 'ENABLED'],
      [false, 'DISABLED'],
    ])(
      'states the enablement state of the loop in the boot line (%s)',
      (enabled, expected) => {
        // The per-tick skip logs at `debug`, so this line is the only place an
        // operator is told whether the loop that just registered will do
        // anything — which is what answers the superseded comment's objection
        // without keeping a second copy of the state.
        settings = makeOperatorSettings({
          overrides: { 'reconciler.enabled': enabled },
        });
        const built = rebuild();
        const log = jest
          .spyOn(Logger.prototype, 'log')
          .mockImplementation(() => {});
        try {
          built.onModuleInit();

          expect(log).toHaveBeenCalledTimes(1);
          expect(log.mock.calls[0][0]).toContain(expected);
        } finally {
          log.mockRestore();
        }
      },
    );

    it('stops listening for changes once the module is destroyed', () => {
      task.onModuleInit();
      task.onModuleDestroy();
      addInterval.mockClear();

      settings.setOverride('reconciler.intervalMs', 30_000);

      // A change arriving during or after teardown must not re-register an
      // interval nothing will ever delete.
      expect(addInterval).not.toHaveBeenCalled();
      expect(registered.size).toBe(0);
    });
  });

  describe('a period change while the process is running', () => {
    it('leaves exactly one interval registered', () => {
      task.onModuleInit();

      settings.setOverride('reconciler.intervalMs', 30_000);

      // The load-bearing assertion, and the reason the fake registry throws
      // the way the real one does: `addInterval` refuses a duplicate name, so
      // a re-registration that forgot to delete first would throw, and one
      // that deleted without re-adding would leave the reconciler with no
      // timer at all. Both are one interval away from correct.
      expect(registered.size).toBe(1);
      expect(deleteInterval).toHaveBeenCalledWith('reconciler-tick');
      expect(addInterval).toHaveBeenCalledTimes(2);
    });

    it('actually fires on the new period', async () => {
      // Re-registering is only worth the machinery if the new timer is the one
      // that fires. The default is 60s; after the change a 5s advance must be
      // enough, and it is not without a real delete-and-re-add.
      jest.useFakeTimers();
      task.onModuleInit();

      settings.setOverride('reconciler.intervalMs', 5_000);

      jest.advanceTimersByTime(5_000);
      await flush();
      expect(tick).toHaveBeenCalledTimes(1);
    });

    it('ignores a change announcement that did not move the period', () => {
      // The emitter carries KEYS, not values, and an operator can PATCH the
      // period they already had. Re-registering on that would restart the
      // countdown, so a script writing the same value every 30 seconds could
      // hold off a 60-second tick forever.
      task.onModuleInit();
      addInterval.mockClear();

      settings.setOverride(
        'reconciler.intervalMs',
        settings.get('reconciler.intervalMs'),
      );

      expect(addInterval).not.toHaveBeenCalled();
      expect(deleteInterval).not.toHaveBeenCalled();
    });

    it('ignores changes to other keys, including enablement', () => {
      // Enablement is honoured by the check inside `runOnce`. Re-registering
      // on it would put back the second copy of the enablement state that
      // #343 removed — and a rapid off/on/off must still leave exactly one
      // interval behind, not three and not zero.
      task.onModuleInit();
      addInterval.mockClear();

      settings.setOverride('reconciler.enabled', false);
      settings.setOverride('reconciler.enabled', true);
      settings.setOverride('reconciler.enabled', false);

      expect(addInterval).not.toHaveBeenCalled();
      expect(deleteInterval).not.toHaveBeenCalled();
      expect(registered.size).toBe(1);
    });

    it('leaves exactly one interval after a burst of period changes', () => {
      task.onModuleInit();

      settings.setOverride('reconciler.intervalMs', 10_000);
      settings.setOverride('reconciler.intervalMs', 20_000);
      settings.setOverride('reconciler.intervalMs', 10_000);

      expect(registered.size).toBe(1);
    });

    it('re-registers once, at the newest value, when a change arrives mid-change', () => {
      // The mutex, exercised through the one door that can reach it: a change
      // listener that fires while `applyIntervalPeriod` is between its delete
      // and its add. The registry is HTTP-concurrent, and `addInterval` throws
      // on a duplicate name — so the second entrant must queue rather than
      // interleave, and must not be DROPPED either, or the interval would be
      // left running at a period nobody asked for.
      task.onModuleInit();

      deleteInterval.mockImplementationOnce((name: string) => {
        const handle = registered.get(name);
        if (handle) clearInterval(handle);
        registered.delete(name);
        // Re-entrant, from inside the critical section.
        settings.setOverride('reconciler.intervalMs', 25_000);
      });

      settings.setOverride('reconciler.intervalMs', 15_000);

      expect(registered.size).toBe(1);
      // Two adds: the first pass registers 15s, and the coalescing pass
      // re-reads and lands on the value that arrived while it was working.
      const periods = addInterval.mock.calls.map(([, handle]) =>
        Number((handle as unknown as { _idleTimeout: number })._idleTimeout),
      );
      expect(periods[periods.length - 1]).toBe(25_000);
    });

    it('does not orphan a tick that is already in flight', async () => {
      // `clearInterval` cancels future firings and has no opinion about a
      // callback that has already started — but only because `runOnce` keeps
      // everything it needs in locals. A tick interrupted mid-flight would
      // lose the write count and the acting phase it is holding, which is the
      // one thing on that path that must never be dropped: a write that
      // happened and was not logged.
      jest.useFakeTimers();
      task.onModuleInit();

      let release: (() => void) | undefined;
      tick.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve(tickRecord());
          }),
      );

      jest.advanceTimersByTime(60_000);
      await flush();
      expect(release).toBeDefined();

      // The period moves out from under the tick that is still awaiting.
      settings.setOverride('reconciler.intervalMs', 5_000);
      expect(registered.size).toBe(1);

      writesIssued = 3;
      release?.();
      // Let the in-flight tick finish its remaining awaits.
      await flush();

      expect(recordExecution).toHaveBeenCalledWith(
        'tick-uuid',
        expect.objectContaining({ writesIssued: 3 }),
      );
    });
  });

  describe('the enablement gate', () => {
    it('does not tick at all while the reconciler is disabled', async () => {
      // The gate covers the WHOLE loop, not just the projection. None of the
      // sweeps, escalations, notifications or the dispatch drain ran at all
      // while a disabled reconciler registered no interval, and #343 is not
      // entitled to turn them on for every deployment that has it off.
      settings.setOverride('reconciler.enabled', false);

      await run();

      expect(tick).not.toHaveBeenCalled();
      expect(drain).not.toHaveBeenCalled();
      expect(recordExecution).not.toHaveBeenCalled();
    });

    it('logs the skip at debug, not at log', async () => {
      settings.setOverride('reconciler.enabled', false);
      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => {});
      const debug = jest
        .spyOn(Logger.prototype, 'debug')
        .mockImplementation(() => {});
      try {
        await run();

        expect(debug).toHaveBeenCalledTimes(1);
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
        debug.mockRestore();
      }
    });

    it('is re-read every firing, so a runtime enable ticks without a restart', async () => {
      jest.useFakeTimers();
      settings.setOverride('reconciler.enabled', false);
      task.onModuleInit();

      jest.advanceTimersByTime(60_000);
      await flush();
      expect(tick).not.toHaveBeenCalled();

      settings.setOverride('reconciler.enabled', true);

      jest.advanceTimersByTime(60_000);
      await flush();
      expect(tick).toHaveBeenCalledTimes(1);
    });
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
