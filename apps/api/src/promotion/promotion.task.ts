import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PromotionService } from './promotion.service';

/**
 * Runs the promotion ladder hourly (#99).
 *
 * ## Why hourly, against a fortnight-long measurement window
 *
 * The cadence has nothing to do with how fast evidence accumulates — a class
 * needs twenty human decisions, which takes days. It is set by how fast a
 * REGRESSION should be acted on. A demotion suspends grants, and every hour
 * between a class starting to make bad calls and the ladder noticing is an
 * hour of unattended action nobody would have authorised. Daily would make
 * that gap up to twenty-four hours; per-minute would spend four database
 * round-trips a minute to re-derive numbers that move on the scale of days.
 *
 * The same interval as the supervisor, and for a related reason: both are
 * off the hot path, and neither has anything useful to say more often.
 *
 * ## It cannot break the scheduler
 *
 * `PromotionService.evaluate` does not throw, and this catches anyway. A task
 * that threw would take the scheduler's other work with it — the reconciler's
 * cleanup, the run-summary sweep, the approval-gate timeout sweeper — for the
 * sake of a rung change nobody was waiting on this hour. The approval sweeper
 * matters most in that list: it is what resolves gates for actions in flight,
 * and taking it down to protect a promotion would be exactly backwards.
 */
@Injectable()
export class PromotionTask {
  private readonly logger = new Logger(PromotionTask.name);

  constructor(private readonly promotion: PromotionService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleEvaluation(): Promise<void> {
    // Returns early rather than evaluating-and-holding. `evaluateLadder`
    // already refuses to change anything while paused, so running it would be
    // harmless — but it would still be four queries an hour, forever, on every
    // deployment that has never turned the ladder on. `SupervisorTask` makes
    // the same call for the same reason.
    //
    // Nothing is recorded for the skipped tick. Unlike the decision log, which
    // must have no gaps because a missing entry there is indistinguishable
    // from an invocation that silently failed, `promotion_states` records
    // CHANGES — and a tick that changed nothing has nothing to say.
    if (!this.promotion.enabled) return;

    try {
      const result = await this.promotion.evaluate();

      if (result.changes.length === 0) {
        this.logger.debug(
          `Promotion ladder: no changes across ${result.holds.length} class(es).`,
        );
        return;
      }

      for (const change of result.changes) {
        this.logger.log(
          `Promotion ladder: "${change.actionClass}" ${change.from} -> ${change.to}` +
            `${change.reason ? ` (${change.reason})` : ''}; ` +
            `${change.notified ? 'operator notified' : 'NOBODY NOTIFIED'}` +
            `${change.grantsSuspended > 0 ? `; ${change.grantsSuspended} grant(s) suspended` : ''}`,
        );
      }
    } catch (error) {
      // Unreachable by contract; kept because "never throws" is a claim about
      // code somebody else will edit.
      this.logger.error(
        `Promotion ladder threw, which it is not supposed to: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
