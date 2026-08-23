import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

import { DispatchQueueService } from '../dispatch/dispatch-queue.service';
import { EscalationsService } from '../escalations/escalations.service';
import { GitLivenessService } from '../liveness/git-liveness.service';
import { EscalationDispatcher } from '../notifications/escalation-dispatcher.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { WatchdogService } from '../watchdog/watchdog.service';
import { MirrorLabelExecutor } from './execute/mirror-label.executor';
import { SpecFeedbackExecutor } from './execute/spec-feedback.executor';
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
    execute = jest.fn().mockResolvedValue({ executed: 0, noops: 0, suppressed: 0, failures: [] });
    drain = jest.fn().mockResolvedValue({
      dispatched: 0,
      stillQueued: 0,
      observed: 0,
      failed: 0,
      unrebuildable: 0,
      repositoriesDisabled: 0,
    });
    listObserved = jest.fn().mockResolvedValue([]);

    task = new ReconcilerTask(
      { get: () => undefined } as unknown as ConfigService,
      { addInterval: jest.fn(), doesExist: jest.fn(), deleteInterval: jest.fn() } as unknown as
        SchedulerRegistry,
      { tick } as unknown as ReconcilerService,
      { execute } as unknown as MirrorLabelExecutor,
      { report } as unknown as SpecFeedbackExecutor,
      { drain } as unknown as DispatchQueueService,
      { listObserved } as unknown as RepositoriesService,
      { sweep: jest.fn().mockResolvedValue({ runsWatched: 0, eventsRecorded: 0, disagreements: [] }) } as unknown as GitLivenessService,
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
        }),
      } as unknown as WatchdogService,
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
      tick.mockResolvedValue(tickRecord({ rejections: [REJECTION], actions: [] }));

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
      tick.mockResolvedValue(tickRecord({ rejections: [REJECTION], actions: [] }));
      listObserved.mockResolvedValue([]);

      await run();

      expect(report).toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
