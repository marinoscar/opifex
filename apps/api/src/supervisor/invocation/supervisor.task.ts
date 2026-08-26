import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { OperatorSettingsService } from '../../settings/operator-settings/operator-settings.service';
import { SupervisorService } from './supervisor.service';

/**
 * Drives the supervisor on a schedule (#89).
 *
 * VISION §7: "It runs on a small model, **on a schedule — not per-event**."
 * This cron is the only thing that invokes the supervisor. Nothing on the
 * dispatch path calls it, and that is the property #94's governing test makes
 * permanent.
 *
 * ## The interval, and why it is coarse
 *
 * Hourly by default, against a reconciler that ticks every minute. The
 * asymmetry is the design: the reconciler is the deterministic hot path and
 * must notice a label promptly, while the supervisor is advisory and its
 * output is read by a human who is not watching. A per-minute supervisor would
 * spend sixty times the quota to tell the same person the same thing.
 *
 * ## It cannot break the scheduler
 *
 * `SupervisorService.invoke()` does not throw, and this catches anyway. A task
 * that threw would take the scheduler's other work with it — including the
 * run-summary sweep and the reconciler's own cleanup — for the sake of a
 * diagnosis nobody was waiting on.
 */
@Injectable()
export class SupervisorTask {
  private readonly logger = new Logger(SupervisorTask.name);

  constructor(
    private readonly supervisor: SupervisorService,
    private readonly settings: OperatorSettingsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleInvocation(): Promise<void> {
    // Checked here as well as inside the service. The service records a
    // `skipped_disabled` row so the log has no gap, which is right when the
    // supervisor is meant to be on and is not — but a deployment that has
    // never configured a supervisor should not accumulate a skip row an hour
    // forever. `logSkips` defaults off for that reason.
    if (!this.supervisor.enabled && !this.logSkips) return;

    try {
      await this.supervisor.invoke();
    } catch (error) {
      // Unreachable by contract; kept because "never throws" is a claim about
      // code that will be edited by someone who has not read it.
      this.logger.error(
        `Supervisor invocation threw, which it is not supposed to: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private get logSkips(): boolean {
    return this.settings.get('supervisor.logSkippedInvocations');
  }
}
