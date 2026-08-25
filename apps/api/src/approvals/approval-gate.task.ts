import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
  ApprovalGateService,
  PARKED_BACKFILL_WINDOW_HOURS,
} from './approval-gate.service';

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

  /**
   * The second pass: parked approvals whose escalation never got raised
   * (#237).
   *
   * ## A separate method on the same tick, on purpose
   *
   * Same schedule, because a parked approval is the irreversible case and a
   * day-long wait for the next daily pass is too long to leave one unTOLD —
   * and because the alternative homes are worse. `sweepTimeouts` cannot host
   * it: its WHERE clause excludes parked rows twice over and that exclusion is
   * the never-auto-approve guarantee. #100's daily brief cannot host it
   * either, today: `rankBrief` walks escalations, quarantined work orders and
   * runs, and knows nothing about approvals at all, so folding this in would
   * mean teaching the brief a new domain to get a five-minute job done daily.
   *
   * Separate rather than appended to `handleTimeouts` so the two fail
   * independently. A database blip in the backfill must not stop the sweep
   * that resolves announced deadlines, because that one has made a promise
   * about a specific time and this one has not.
   *
   * It is enabled wherever the API runs — `ScheduleModule.forRoot()` is
   * unconditional in `AppModule` and `ApprovalsModule` provides this task with
   * no flag — so there is no deployment where approvals are raised and this
   * does not run.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleParkedEscalations(): Promise<void> {
    try {
      const result = await this.gate.backfillParkedEscalations();

      // A repair means something failed earlier that nothing else reported as
      // it happened. `warn`, not `log`: a quiet successful backfill would hide
      // the outage that made it necessary.
      if (result.raised > 0 || result.linked > 0) {
        this.logger.warn(
          `Parked approval escalation backfill repaired ` +
            `${result.raised + result.linked} request(s) ` +
            `(${result.raised} escalated, ${result.linked} re-linked to an ` +
            'escalation that already existed).',
        );
      }

      if (result.failed > 0) {
        this.logger.error(
          `${result.failed} parked approval(s) still have no escalation ` +
            'after a retry. The action is blocked and the approval is in the ' +
            'pending queue, but there is no escalation record and no ' +
            'delivery receipt. The next tick retries.',
        );
      }

      // Past the retry bound. Loud on every pass, with a marker an alert can
      // match, and deliberately NOT deduplicated into silence: the same end
      // state #136's attempt cap produces, where the honest thing is to keep
      // saying that nobody got a receipt rather than to stop mentioning it.
      if (result.abandoned > 0) {
        this.logger.error(
          `PARKED APPROVAL NEVER ESCALATED — ${result.abandoned} request(s) ` +
            `have been parked with no escalation for over ` +
            `${PARKED_BACKFILL_WINDOW_HOURS}h and will NOT be retried again. ` +
            'They are still blocked and still waiting on a person; nothing ' +
            'will auto-approve them. Answer them from the approvals queue.',
        );
      }
    } catch (error) {
      this.logger.error(
        `Parked approval escalation backfill failed; the next tick will ` +
          `retry the same rows: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
