import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

import { POLL_INTERVAL_MS, RunPollerService } from './run-poller.service';

const INTERVAL_NAME = 'run-poller-tick';

/**
 * Drives {@link RunPollerService.tick} on a schedule.
 *
 * Same shape as `ReconcilerTask`, and for the same reason: `@Interval` takes
 * its period at decoration time, so it would bake the interval into the build.
 *
 * ## Why this is its own interval and not part of the reconciler tick
 *
 * The reconciler runs once a minute; #54 declares a `full`-streaming run
 * silent after ninety seconds. Polling on the reconciler's schedule would put
 * two thirds of the tightest silence window between one poll and the next, so
 * a single slow reconciler tick would make healthy runs look silent. These are
 * different loops with different deadlines, and merging them would couple the
 * fastest requirement in the system to the slowest.
 *
 * It also follows the enablement of the runner rather than the reconciler: a
 * poller with no runner enabled has nothing to poll, and one running without
 * the reconciler is still useful for a manually dispatched run.
 */
@Injectable()
export class RunPollerTask implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunPollerTask.name);

  constructor(
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
    private readonly poller: RunPollerService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<boolean>('runners.claudeCodeLocal.enabled') !== true) {
      // No interval at all rather than one that wakes to decide it is off —
      // the same argument the reconciler makes, and the same reason: a
      // disabled loop that still appears in every profile invites the question
      // of whether it is really disabled.
      this.logger.log('Run poller is DISABLED (no runner is enabled)');
      return;
    }

    const handle = setInterval(() => {
      void this.runOnce();
    }, POLL_INTERVAL_MS);

    this.scheduler.addInterval(INTERVAL_NAME, handle);
    this.logger.log(`Run poller tick registered every ${POLL_INTERVAL_MS}ms`);
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  /**
   * The scheduler's entry point.
   *
   * `tick()` is written not to throw, and this catches anyway: an unhandled
   * rejection from a `setInterval` callback has no caller to propagate to and
   * takes the process down under Node's default policy. A dead process is a
   * dead factory — the exact silent failure this system exists to eliminate.
   */
  async runOnce(): Promise<void> {
    try {
      const result = await this.poller.tick();

      // Logged only when something happened. A line every fifteen seconds
      // saying nothing happened is how a log stops being read, and this one
      // competes for attention with the escalations that matter.
      if (result.eventsIngested > 0 || result.lost > 0 || result.failed > 0) {
        this.logger.log(
          `Polled ${result.polled} run(s): ${result.eventsIngested} event(s) ingested, ` +
            `${result.duplicates} duplicate(s), ${result.lost} lost, ${result.failed} failed`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Run poller tick threw, which it should not: ${
          error instanceof Error ? error.stack : String(error)
        }`,
      );
    }
  }
}
