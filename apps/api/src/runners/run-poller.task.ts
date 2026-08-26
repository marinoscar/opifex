import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import { OperatorSettingsService } from '../settings/operator-settings/operator-settings.service';
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
 *
 * ## Why the interval is registered even when no runner is enabled (#343)
 *
 * This file used to register no interval at all when the runner was off, and
 * argued for it: a disabled loop that still appears in every profile invites
 * the question of whether it is really disabled. That argument was correct for
 * as long as the only way to enable a runner was to edit `.env` and restart —
 * "off" was then a fact fixed for the life of the process, and the cheapest
 * way to hold a fixed fact is not to build the machinery it would gate.
 *
 * `runners.claudeCodeLocal.enabled` is a live managed key now (ADR-0018), and
 * the argument inverts. `onModuleInit` runs exactly once; an interval created
 * only there, conditioned on the value at that instant, can never come into
 * existence afterwards. Its presence or absence becomes a SECOND copy of the
 * enablement state that has to be kept in sync with the first, and two copies
 * that can disagree is precisely what leaves an operator unable to say which
 * one is true — the doubt the old comment was trying to prevent, arrived by
 * the other road.
 *
 * For this loop the second copy is not merely stale, it is dangerous.
 * `runner-registration.service.ts` and the dispatch admission path both read
 * that key lazily, so flipping it on at runtime would register the runner and
 * start admitting work while no poller existed. Runs would start, never be
 * polled, never conclude, and hold their dispatch slots — strictly worse than
 * leaving the runner off. Registering unconditionally is what makes the flag's
 * two consumers reachable by the same flip.
 *
 * The cost is accepted and named rather than hidden: a deployment with no
 * runner does wake every {@link POLL_INTERVAL_MS} to decide it has nothing to
 * do. The skip logs at `debug`, not `log`, so it costs no attention, and the
 * enablement state is stated once in the boot line — which answers the old
 * comment's objection without keeping a second copy of the state around.
 *
 * No `SchedulerRegistry` surgery is needed here, unlike `ReconcilerTask`:
 * {@link POLL_INTERVAL_MS} is a module constant, not a managed key, so the
 * period this registers at can never change under a running process.
 */
@Injectable()
export class RunPollerTask implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunPollerTask.name);

  constructor(
    private readonly settings: OperatorSettingsService,
    private readonly scheduler: SchedulerRegistry,
    private readonly poller: RunPollerService,
  ) {}

  onModuleInit(): void {
    // Unconditional. The enablement check lives in `runOnce`, re-read on every
    // firing, so that turning a runner on takes effect on the next poll rather
    // than on the next restart. See the class comment for why this reverses
    // the argument this method used to make.
    const handle = setInterval(() => {
      void this.runOnce();
    }, POLL_INTERVAL_MS);

    this.scheduler.addInterval(INTERVAL_NAME, handle);

    // The one place the enablement state is reported. It is stated at boot
    // rather than on every skipped tick, because a line every fifteen seconds
    // saying nothing happened is how a log stops being read.
    this.logger.log(
      `Run poller tick registered every ${POLL_INTERVAL_MS}ms; ` +
        (this.settings.get('runners.claudeCodeLocal.enabled')
          ? 'the local runner is ENABLED and runs will be polled'
          : 'the local runner is DISABLED, so every tick will skip until it is enabled'),
    );
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
    // Re-read every firing, not captured at boot: this is what makes the flag
    // live for this loop, and it is the half of #343 that keeps a runtime
    // enable from admitting work nothing is watching.
    if (!this.settings.get('runners.claudeCodeLocal.enabled')) {
      // `debug`, not `log`. A disabled deployment ticks four times a minute
      // forever, and an INFO line each time would drown the escalations this
      // log exists to carry. The state an operator needs is in the boot line.
      this.logger.debug('Run poller skipped: no runner is enabled');
      return;
    }

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
