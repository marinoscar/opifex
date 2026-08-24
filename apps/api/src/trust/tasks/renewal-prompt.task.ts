import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { RenewalNotifier } from '../../notifications/renewal-notifier.service';
import { getActionClass } from '../../supervisor/action-classes';
import { NEAR_EXPIRY_WINDOW_MS } from '../defaults';
import { TrustGrantService } from '../trust-grant.service';

/**
 * The expiry prompt (#115, VISION §8): "Renewal is one tap; silence revokes."
 *
 * Hourly, over `NEAR_EXPIRY_WINDOW_MS` (48 hours), notifying ONCE PER GRANT
 * for the whole of that window.
 *
 * ## The dedupe is the feature
 *
 * An hourly cron over a 48-hour window would, without a dedupe, produce up to
 * 48 identical notifications about one grant. That is the exact interruption
 * VISION §8 exists to remove, and worse than none: it teaches the operator
 * that trust notifications are noise to be swiped away, and the escalation
 * that genuinely needs them gets swiped with the rest. So the claim is a
 * conditional UPDATE on `renewalPromptedAt` — see
 * `TrustGrantService.claimRenewalPrompt` for why it is taken BEFORE the send
 * and not after.
 *
 * ## Hourly rather than daily
 *
 * The window is 48 hours and the prompt fires once, so the cadence only
 * decides HOW SOON after a grant enters the window the operator hears about
 * it. Hourly means at most an hour of lag; daily would mean a grant entering
 * the window just after the run is first mentioned 24 hours later, with 24
 * hours left, which halves a window chosen to survive a weekend.
 *
 * ## No config switch
 *
 * Deliberately unlike `DailyBriefTask`, which is gated on
 * `supervisor.enabled`. Trust grants exist independently of the AI supervisor
 * — they are created by an operator tapping "Always approve this class", and
 * they authorize execution whether or not a model is reachable. A deployment
 * with grants and no supervisor still needs to be told before its grants
 * lapse; gating this would mean the "silence revokes" half runs and the
 * "renewal is one tap" half does not, which is the friction VISION §8 warns
 * turns into blanket trust. When there are no grants the sweep finds nothing
 * and costs one indexed query an hour.
 */
@Injectable()
export class RenewalPromptTask {
  private readonly logger = new Logger(RenewalPromptTask.name);

  constructor(
    private readonly grants: TrustGrantService,
    private readonly notifier: RenewalNotifier,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleRenewalPrompts(): Promise<void> {
    // One clock read for the whole pass. Two reads would let a grant be
    // selected as "expiring within 48 hours" against one instant and have its
    // remaining time rendered against another, which is how a notification
    // ends up saying a grant expires in a negative number of hours.
    await this.run(new Date());
  }

  /**
   * The body, with `now` injected — the pattern every policy function in this
   * codebase uses, so the boundary behaviour can be pinned in a spec.
   *
   * Returns how many prompts were sent, for the log line and for tests that
   * need to assert "twice through, one send".
   */
  async run(now: Date): Promise<number> {
    let sent = 0;
    let claimed = 0;

    try {
      const expiring = await this.grants.expiringSoon(
        NEAR_EXPIRY_WINDOW_MS,
        now,
      );

      for (const grant of expiring) {
        // Claim first. A grant already prompted about returns false here and
        // is skipped without a query to the transport — which is what makes
        // the second run of the hour silent rather than merely quieter.
        if (!(await this.grants.claimRenewalPrompt(grant.id, now))) continue;
        claimed += 1;

        // The registry lookup happens HERE, one layer above the payload
        // builder, because nothing under `src/notifications/` may import
        // `src/supervisor/` — the governing test for #94 asserts it, and it
        // caught exactly this import in #98. `getActionClass` returns
        // undefined for an unrecognised id; normalised to null so the builder
        // falls back to the raw class id rather than to a generic phrase.
        const actionClassTitle = getActionClass(grant.actionClass)?.title;

        const accepted = await this.notifier.send(
          {
            id: grant.id,
            actionClass: grant.actionClass,
            actionClassTitle: actionClassTitle ?? null,
            repositoryId: grant.repositoryId,
            expiresAt: new Date(grant.expiresAt),
            createdAt: new Date(grant.createdAt),
            spentUsd: grant.spentUsd,
            budgetCeilingUsd: grant.budgetCeilingUsd,
            remainingBudgetUsd: grant.remainingBudgetUsd,
            actionsAuthorized: grant.actionsAuthorized,
            actionsFailed: grant.actionsFailed,
            failureRate: grant.failureRate,
          },
          now,
        );

        if (accepted) sent += 1;
      }
    } catch (error) {
      // A failed pass is retried by the next hour's tick, and the grants it
      // did not reach are still inside a 48-hour window. Nothing here may
      // throw into the scheduler: an unhandled rejection in a cron handler
      // takes the process down on some Node configurations, and losing the
      // API to a failed renewal REMINDER would be an absurd trade.
      this.logger.error(
        `Renewal prompt sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (claimed > 0) {
      this.logger.log(
        `Renewal prompts: ${claimed} grant(s) newly claimed, ${sent} ` +
          'accepted by a transport. Each grant is prompted about once, ever; ' +
          'a grant nobody renews expires as scheduled.',
      );
    }

    return sent;
  }
}
