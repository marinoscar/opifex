import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { ApprovalGateService } from './approval-gate.service';

/**
 * The clock behind ADR-0014's timeout policy (#97).
 *
 * ## Why five minutes against a four-hour window
 *
 * The tick is the RESOLUTION of the deadline, not the deadline itself. At five
 * minutes a request announced as "auto-denied at 18:00" is resolved by 18:05
 * at the latest, which is inside the noise of a four-hour promise and far
 * inside anything an operator would notice. A coarser tick would make the
 * announced time a lie by an amount that grows with the tick, and VISION §8's
 * whole approval contract is that what the notification said would happen is
 * what happens.
 *
 * It is also cheap in a way the supervisor's hourly cron is not: this is one
 * indexed query over `(status, timeoutAt)` that returns nothing at all most of
 * the time, with no model invocation and no quota behind it. The asymmetry with
 * `SupervisorTask` is deliberate and is the same one that file argues — the
 * expensive advisory pass runs rarely, the cheap deterministic sweep runs
 * often.
 *
 * ## It cannot break the scheduler
 *
 * A throw here would take the scheduler's other work with it — the reconciler
 * tick, the merge-state pass, the run-summary sweep — for the sake of one
 * batch of approvals that will be picked up again in five minutes anyway,
 * because `sweepTimeouts` is idempotent: it selects on `status: 'pending'` and
 * writes conditionally, so a failed tick loses nothing but time. The catch is
 * therefore a genuine recovery rather than a formality.
 */
@Injectable()
export class ApprovalGateTask {
  private readonly logger = new Logger(ApprovalGateTask.name);

  constructor(private readonly gate: ApprovalGateService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleTimeouts(): Promise<void> {
    try {
      const result = await this.gate.sweepTimeouts();

      // Loud, and only when it should be. `skippedParked` is structurally
      // impossible (a parked request has no `timeoutAt`), so a non-zero value
      // means the never-auto-approve invariant has been broken somewhere else
      // and must not be buried in a debug line.
      if (result.skippedParked > 0) {
        this.logger.error(
          `${result.skippedParked} approval(s) recorded as park_and_escalate ` +
            'were selected by the timeout sweep, which should be impossible. ' +
            'They were left unresolved. VISION §8: an irreversible action is ' +
            'never auto-approved, under any grant or any timeout.',
        );
      }
    } catch (error) {
      this.logger.error(
        `Approval timeout sweep failed; the next tick will retry the same ` +
          `rows: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
