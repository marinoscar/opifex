import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

import { GitLivenessService } from '../liveness/git-liveness.service';
import { WatchdogService } from '../watchdog/watchdog.service';
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
  private async sweepWatchdog(): Promise<ReconcileAction[]> {
    try {
      const result = await this.watchdog.sweep();
      if (result.silentRuns > 0) {
        this.logger.warn(
          `Watchdog: ${result.silentRuns} of ${result.runsJudged} run(s) silent past threshold`,
        );
      }
      return result.actions;
    } catch (error) {
      this.logger.error(
        `Watchdog sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
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
      const watchdogActions = await this.sweepWatchdog();

      // COMPUTE, then APPLY — two steps, two components. This method is the
      // only place they meet, which is what keeps `ReconcilerService` unable
      // to act on its own conclusions.
      const record = await this.reconciler.tick();

      // The watchdog's actions are computed alongside the reconciler's and,
      // in Phase 3, executed just as little. The mirror-label executor below
      // ignores everything that is not a label action, so a kill-and-re-run
      // passing through it is inert by construction rather than by a check.
      const actions = [...watchdogActions, ...record.actions];
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
