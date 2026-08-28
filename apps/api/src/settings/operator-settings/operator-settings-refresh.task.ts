import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import {
  OPERATOR_SETTINGS_REFRESH_INTERVAL_MS,
  OperatorSettingsService,
} from './operator-settings.service';

const INTERVAL_NAME = 'operator-settings-refresh';

/**
 * Re-reads the operator settings overlay on a fixed interval (#339, epic
 * #332).
 *
 * ## Why a poll, and why fifteen seconds
 *
 * `OperatorSettingsService.get()` is synchronous by design — the consumers it
 * replaces read configuration inside pure decision functions and property
 * getters, where there is no `await` to add — so the database layer has to
 * live in memory, and something has to put it there. Two things make that a
 * loop rather than a one-off:
 *
 * - **It recovers a boot that started without a database.** `PrismaService`
 *   retries three times over about 1.75 seconds and then boots anyway (#161),
 *   because a process that has exited cannot be asked what went wrong. A boot
 *   through that window has no overlay, reports `status: 'unavailable'`, and
 *   would keep resolving from the environment for the life of the process if
 *   nothing tried again. This is the thing that tries again.
 * - **It bounds staleness across replicas.** A write through one API process
 *   updates that process's memory immediately; any other process holding the
 *   same database learns about it on its next tick and not before.
 *
 * Fifteen seconds is the house model, not a new one: `RunnerRegistrationTask`
 * re-reads every sixty (#162, #276), and this is the same shape with a shorter
 * period because an operator changing a setting is watching the effect happen,
 * where a runner converging is not being watched by anyone.
 *
 * ADR-0018's Alternatives section considered making this event-driven instead
 * and deferred it deliberately; a poll is what this issue builds.
 *
 * ## Why the interval is registered unconditionally
 *
 * There is nothing to gate it on. This is the loop that recovers the state in
 * which nothing is known — including, potentially, whatever flag someone might
 * be tempted to gate it with. ADR-0018 §5 makes the general version of this
 * argument for the reconciler and the run poller.
 *
 * ## Why the first load is NOT here
 *
 * `OperatorSettingsService.onModuleInit` does it. `OperatorSettingsModule` is
 * `@Global` and initialises early, so a consumer in another module reading a
 * managed key in its own `onModuleInit` gets the overlay rather than the
 * environment — a consumer registered in THIS module does not, and must wait
 * for `onApplicationBootstrap`; see that hook's comment and #436. Starting a
 * second load here would mean two queries racing on the first tick of every
 * process, for no benefit — `RunnerRegistrationTask` declines the same thing
 * for the same reason.
 */
@Injectable()
export class OperatorSettingsRefreshTask
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(OperatorSettingsRefreshTask.name);

  constructor(
    private readonly scheduler: SchedulerRegistry,
    private readonly settings: OperatorSettingsService,
  ) {}

  onModuleInit(): void {
    const handle = setInterval(() => {
      void this.runOnce();
    }, OPERATOR_SETTINGS_REFRESH_INTERVAL_MS);

    this.scheduler.addInterval(INTERVAL_NAME, handle);
    this.logger.log(
      `Operator settings overlay refreshes every ${OPERATOR_SETTINGS_REFRESH_INTERVAL_MS}ms`,
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
   * `refresh()` is written not to throw — an unreachable database is a state
   * it reports, not an exception — and this catches anyway: an unhandled
   * rejection from a `setInterval` callback has no caller to propagate to and
   * takes the process down under Node's default policy. A dead process is a
   * dead factory, which would be a poor way to fix a stale settings value.
   *
   * Logs nothing about a successful pass. The service already says when the
   * overlay went away and when it came back, and only when it CHANGED; a line
   * here would be four an hour saying nothing happened.
   */
  async runOnce(): Promise<void> {
    try {
      await this.settings.refresh();
    } catch (error) {
      this.logger.error(
        `The operator settings refresh threw, which it should not: ${
          error instanceof Error ? error.stack : String(error)
        }`,
      );
    }
  }
}
