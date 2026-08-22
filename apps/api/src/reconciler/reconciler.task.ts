import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

import { EscalationsService } from '../escalations/escalations.service';
import { GitLivenessService } from '../liveness/git-liveness.service';
import { EscalationDispatcher } from '../notifications/escalation-dispatcher.service';
import { WatchdogService, type WatchdogSweepResult } from '../watchdog/watchdog.service';
import type { ReconcileAction } from './diff/actions.types';
import { MirrorLabelExecutor } from './execute/mirror-label.executor';
import { ReconcilerService } from './reconciler.service';
import { RepositoriesService } from '../repositories/repositories.service';

const INTERVAL_NAME = 'reconciler-tick';

/**
 * Drives {@link ReconcilerService.tick} on a schedule.
 *
 * ## Why a registered interval rather than `@Cron`
 *
 * The three existing tasks in this codebase (`auth/tasks`, `device-auth/tasks`,
 * `storage/tasks`) use `@Cron(CronExpression.EVERY_DAY_AT_4AM)` and are the
 * pattern #45 points at — but a decorator argument is evaluated at class
 * definition time, so the interval would be baked into the build. #45 requires
 * it be configurable without a code change, which means registering the
 * interval at runtime once `ConfigService` has been read.
 *
 * `SchedulerRegistry` is part of the `@nestjs/schedule` already wired at the
 * root, so this adds no dependency.
 */
@Injectable()
export class ReconcilerTask implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconcilerTask.name);

  constructor(
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
    private readonly reconciler: ReconcilerService,
    private readonly executor: MirrorLabelExecutor,
    private readonly repositories: RepositoriesService,
    private readonly liveness: GitLivenessService,
    private readonly watchdog: WatchdogService,
    private readonly escalations: EscalationsService,
    private readonly dispatcher: EscalationDispatcher,
  ) {}

  onModuleInit(): void {
    const enabled = this.config.get<boolean>('reconciler.enabled') ?? false;

    if (!enabled) {
      // No interval is registered at all, rather than one that returns early.
      // A disabled reconciler that still wakes every 60 seconds to decide it
      // is disabled shows up in every profile and every log, and invites the
      // question of whether it is really off.
      this.logger.log('Reconciler is DISABLED (RECONCILER_ENABLED is not true)');
      return;
    }

    const intervalMs = this.config.get<number>('reconciler.intervalMs') ?? 60_000;

    const handle = setInterval(() => {
      // Deliberately not awaited: `setInterval` cannot await, and the lease is
      // what makes a slow tick safe. If this one runs long, the next fires,
      // fails to take the lease, and records `skipped-locked` — which is the
      // designed behaviour, not a race.
      void this.runOnce();
    }, intervalMs);

    this.scheduler.addInterval(INTERVAL_NAME, handle);
    this.logger.log(`Reconciler tick registered every ${intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  /**
   * The scheduler's entry point.
   *
   * `tick()` is written not to throw, but this catches anyway: an unhandled
   * rejection from a `setInterval` callback has no caller to propagate to and
   * takes the process down under Node's default policy. A dead process is a
   * dead factory, which is precisely the silent failure this system exists to
   * eliminate.
   */
  /**
   * Derive git liveness for every live run.
   *
   * Separated and independently caught: the git watcher is one of two
   * INDEPENDENT liveness sources (VISION §9), and a failure in it must not
   * stop the reconciler tick that follows. An outage in one source is exactly
   * when the other matters most.
   */
  private async sweepLiveness(): Promise<void> {
    try {
      const result = await this.liveness.sweep();
      if (result.eventsRecorded > 0 || result.disagreements.length > 0) {
        this.logger.log(
          `Git liveness: ${result.runsWatched} run(s), ${result.eventsRecorded} new event(s), ` +
            `${result.disagreements.length} disagreement(s) with runner-reported liveness`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Git liveness sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Judge every live run for silence.
   *
   * Independently caught, like the liveness sweep: a watchdog failure must not
   * stop the reconciler, and a reconciler failure must not stop the watchdog.
   * They answer different questions and one being broken is when the other
   * matters most.
   */
  private async sweepWatchdog(): Promise<WatchdogSweepResult> {
    try {
      const result = await this.watchdog.sweep();
      if (result.parkedRuns > 0 || result.resumableRuns > 0) {
        // Logged at `log` rather than `warn`: a parked run is the system
        // working, and VISION §1's rate-limit case is where Opifex most
        // visibly recovers hours with nobody involved.
        this.logger.log(
          `Watchdog: ${result.parkedRuns} run(s) parked, ${result.resumableRuns} due to resume`,
        );
      }
      if (result.silentRuns > 0 || result.loopingRuns > 0) {
        this.logger.warn(
          `Watchdog: ${result.runsJudged} run(s) judged — ${result.silentRuns} silent, ` +
            `${result.loopingRuns} looping` +
            (result.loopCheckUnavailable > 0
              ? `, ${result.loopCheckUnavailable} unmeasurable for loops`
              : ''),
        );
      }
      return result;
    } catch (error) {
      this.logger.error(
        `Watchdog sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // No runs judged, rather than an empty sweep: a watchdog that threw has
      // established nothing about any run, and reporting them healthy would
      // resolve their escalations on the strength of a failure.
      return {
        runsJudged: 0,
        judgedRunIds: [],
        actions: [],
        silentRuns: 0,
        loopingRuns: 0,
        loopCheckUnavailable: 0,
        parkedRuns: 0,
        resumableRuns: 0,
      };
    }
  }

  /**
   * Turn `escalate` actions into escalation records.
   *
   * VISION §9: escalation is an action, not telemetry — so it happens here,
   * alongside the label executor, and NOT inside the components that decide
   * to escalate. Detection stays a pure function over data; persistence stays
   * in the one place that is allowed to act.
   *
   * Independently caught for the same reason the sweeps are: an escalation
   * that cannot be written must not take down the tick that would notice the
   * next problem.
   */
  private async raiseEscalations(
    actions: ReconcileAction[],
    judgedRunIds: string[],
  ): Promise<void> {
    try {
      const { raised, deduplicated } = await this.escalations.raiseFrom(actions);
      if (raised > 0) {
        this.logger.warn(`Escalations: ${raised} raised, ${deduplicated} suppressed as duplicates`);
      }

      // A run the watchdog judged and did NOT escalate about has recovered.
      // Conservatively per RUN rather than per kind: if anything at all is
      // still wrong with a run, nothing about it is cleared automatically.
      // Over-resolving would delete a problem nobody ever saw.
      const stillEscalating = new Set(
        actions
          .filter((action) => action.type === 'escalate')
          .map((action) => action.runId)
          .filter((runId): runId is string => Boolean(runId)),
      );
      const recovered = judgedRunIds.filter((runId) => !stillEscalating.has(runId));

      const resolved = await this.escalations.resolveStale(recovered);
      if (resolved > 0) {
        this.logger.log(`Escalations: ${resolved} resolved because the condition cleared`);
      }
    } catch (error) {
      this.logger.error(
        `Raising escalations failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Actually tell somebody.
   *
   * Separate from raising, and independently caught, because they fail
   * independently: a push service outage must not stop escalations being
   * RECORDED, and a database problem must not stop the ones already recorded
   * being SENT.
   *
   * Runs unconditionally rather than only when this tick raised something.
   * The queue is what is `raised`, not what this pass produced — an
   * escalation raised while the push service was down has to be picked up by
   * a later tick, and a dispatch conditional on new work never would.
   */
  private async dispatchEscalations(): Promise<void> {
    try {
      const result = await this.dispatcher.dispatchPending();

      if (result.dispatched > 0 || result.rerouted > 0) {
        this.logger.log(
          `Notifications: ${result.dispatched} dispatched` +
            (result.rerouted > 0 ? `, ${result.rerouted} via the fallback path` : '') +
            // Reported even on success: escalations that only went out on a
            // retry mean the transport is limping, and a line that said only
            // "dispatched" would make that look healthy.
            (result.retried > 0 ? `, ${result.retried} on a retry` : ''),
        );
      }
      if (result.failed > 0 || result.timedOut > 0 || result.abandoned > 0) {
        this.logger.error(
          `Notifications: ${result.failed} could not be sent, ` +
            `${result.timedOut} were sent and never confirmed by a device` +
            (result.abandoned > 0
              ? `, ${result.abandoned} hit the attempt cap and will NOT be retried`
              : ''),
        );
      }
    } catch (error) {
      this.logger.error(
        `Dispatching escalations failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async runOnce(): Promise<void> {
    try {
      // Liveness FIRST, so the tick's projection sees the freshest run state.
      // Deriving it after would mean every conclusion is one tick stale — and
      // for a stalled run, one tick stale is the difference the watchdog in
      // #54 is measuring.
      await this.sweepLiveness();

      // Then judge liveness, on the freshest state the sweep just produced.
      // Running the watchdog BEFORE the sweep would judge every run one tick
      // stale — and for a stall, one tick stale is exactly the latency #54 is
      // trying to minimise.
      const watchdog = await this.sweepWatchdog();

      // COMPUTE, then APPLY — two steps, two components. This method is the
      // only place they meet, which is what keeps `ReconcilerService` unable
      // to act on its own conclusions.
      const record = await this.reconciler.tick();

      // The watchdog's actions are computed alongside the reconciler's and,
      // in Phase 3, executed just as little. The mirror-label executor below
      // ignores everything that is not a label action, so a kill-and-re-run
      // passing through it is inert by construction rather than by a check.
      const actions = [...watchdog.actions, ...record.actions];

      // BEFORE the mirror-label gate below. Notification is a reconciler
      // output on the same footing as dispatch (VISION §9), so it must not
      // sit behind a flag that exists to keep label writes off during the
      // observation week — the whole point of that week is being told what
      // the system would have done.
      await this.raiseEscalations(actions, watchdog.judgedRunIds);

      // Unconditional, and before the early return below: the notification
      // queue is everything still `raised`, not what this pass produced. An
      // escalation raised while the push service was down is picked up here
      // on a later tick, which a dispatch gated on new work never would.
      await this.dispatchEscalations();

      if (actions.length === 0) return;

      const enabledFor = new Set(
        (await this.repositories.listObserved())
          .filter((repository) => repository.mirrorLabelsEnabled)
          .map((repository) => `${repository.owner}/${repository.name}`),
      );

      // Skip the call entirely when nothing has opted in, rather than handing
      // the executor a list it will suppress item by item. During the
      // observation week this is every tick.
      if (enabledFor.size === 0) return;

      await this.executor.execute(actions, enabledFor);
    } catch (error) {
      this.logger.error(
        `Reconciler tick threw, which tick() is supposed to prevent: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
