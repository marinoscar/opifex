import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import {
  REGISTRATION_INTERVAL_MS,
  RunnerRegistrationService,
} from './runner-registration.service';

const INTERVAL_NAME = 'runner-registration-tick';

/**
 * Drives {@link RunnerRegistrationService.registerAll} on a schedule.
 *
 * ## Why this exists (#162)
 *
 * Registration used to happen exactly once, in `onModuleInit`, and the failure
 * path returned. So a database that was briefly away at boot — the ordinary
 * case in Compose, where PostgreSQL is an external container that
 * `depends_on` cannot order against — left the fleet table empty for the life
 * of the process, and every work order queued behind *"No runners are
 * registered."* until somebody restarted the API. One ERROR line at boot was
 * the only evidence, and it had scrolled past.
 *
 * ## Why its own interval, and not a call from an existing tick
 *
 * #162 proposes hanging registration off the reconciler tick, and there is a
 * real argument for it: a new timer is a new thing to shut down cleanly, and
 * the reconciler is already the loop that recomputes desired state. It is the
 * wrong home anyway, and the reason is mechanical rather than aesthetic:
 * `ReconcilerTask` registers NO interval at all unless `RECONCILER_ENABLED` is
 * true, and `RunPollerTask` registers none unless a runner is enabled. Both
 * default off. Registration hung off either would therefore fail to converge
 * on precisely the deployments where the fleet table is empty and somebody is
 * trying to find out why — and "the fleet is empty" is the state an operator
 * has to see resolved BEFORE they are willing to turn dispatch on.
 *
 * That is also why this interval is registered unconditionally. Registering a
 * disabled runner is not a no-op: the row is written with `enabled: false`,
 * which is what lets dispatch answer "the only runner is disabled" instead of
 * "no runner is registered" — a distinction the service's own comment calls
 * the difference between flipping a flag and hunting a bug in registration.
 * A registration loop gated on the flag it exists to record would be circular.
 *
 * The shutdown cost is paid the same way `ReconcilerTask` and `RunPollerTask`
 * pay it: a named interval in `SchedulerRegistry`, deleted in
 * `onModuleDestroy`. This is the third instance of that shape, not a new one.
 *
 * ## What it is not
 *
 * Not a retry framework, and not a backoff schedule. One fixed interval, one
 * idempotent call, and the noise control lives in the service where the
 * transient/permanent distinction is actually known. `PrismaService`'s three
 * hard-coded delays are the precedent for how small this is meant to stay.
 */
@Injectable()
export class RunnerRegistrationTask implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunnerRegistrationTask.name);

  constructor(
    private readonly scheduler: SchedulerRegistry,
    private readonly registration: RunnerRegistrationService,
  ) {}

  /**
   * Register the interval only. The first REGISTRATION is
   * `RunnerRegistrationService.onModuleInit`'s job, which runs at boot for the
   * reasons its own comment gives; starting a second one here would mean two
   * upserts racing each other on the first tick of every process.
   */
  onModuleInit(): void {
    const handle = setInterval(() => {
      void this.runOnce();
    }, REGISTRATION_INTERVAL_MS);

    this.scheduler.addInterval(INTERVAL_NAME, handle);
    this.logger.log(
      `Runner registration re-runs every ${REGISTRATION_INTERVAL_MS}ms until it converges`,
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
   * `registerAll()` is written not to throw, and this catches anyway: an
   * unhandled rejection from a `setInterval` callback has no caller to
   * propagate to and takes the process down under Node's default policy. A
   * dead process is a dead factory — the exact silent failure this system
   * exists to eliminate, and it would be a poor way to fix #162.
   *
   * Logs nothing about the pass itself. The service already says what happened
   * and, more importantly, says it only when it CHANGED; a summary line here
   * would reintroduce the every-minute noise that suppression exists to
   * prevent.
   */
  async runOnce(): Promise<void> {
    try {
      await this.registration.registerAll();
    } catch (error) {
      this.logger.error(
        `Runner registration tick threw, which it should not: ${
          error instanceof Error ? error.stack : String(error)
        }`,
      );
    }
  }
}
