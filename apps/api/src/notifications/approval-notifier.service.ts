import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  buildApprovalPayload,
  type ApprovalForNotification,
} from './approval-payload';
import {
  FallbackWebhookTransport,
  WEBHOOK_TARGET,
} from './fallback-webhook.transport';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { WebPushTransport } from './web-push.transport';

/**
 * Puts a raised approval on the operator's phone (#98, VISION §8).
 *
 * ## Its own service rather than a branch inside `EscalationDispatcher`
 *
 * The dispatcher is a LIFECYCLE machine, not a send function: it moves
 * escalation rows between `raised`, `dispatched`, `delivered` and `failed`,
 * retries up to `MAX_DELIVERY_ATTEMPTS`, prunes gone subscriptions, and mints
 * receipt tokens. Every one of those behaviours is defined over an
 * `Escalation` row. An approval has no such row and must not be given one —
 * doing so would put every unanswered question into the stop-to-notified
 * percentiles that VISION success metric 1 computes over escalations, which
 * measure how long a broken run went unnoticed. Teaching the dispatcher to
 * handle a second kind of subject would have meant making each of those five
 * behaviours conditional, and the risk there is not the complexity: it is that
 * a bug in the approval branch changes escalation delivery, which is the one
 * path this project exists to keep working.
 *
 * So this rides the same `NotificationTransport` seam directly, exactly as
 * `DailyBriefService` does and for the same stated reason.
 *
 * ## Push first, webhook second
 *
 * The same order and the same seam as the dispatcher, so a deployment
 * configured for escalations is configured for approvals with no extra
 * variables. The webhook is a DIFFERENT PATH rather than a retry (#58): if the
 * push service is down or no device is subscribed, trying push again produces
 * the same silence.
 *
 * ## Nothing here throws
 *
 * `send` returns a boolean and swallows everything. See the comment at the
 * call site in `ApprovalGateService.gate`: an approval that exists and was not
 * delivered is recoverable — the row is in the queue, `GET /api/approvals`
 * shows it — while an approval that was never written is not.
 */
@Injectable()
export class ApprovalNotifier {
  private readonly logger = new Logger(ApprovalNotifier.name);

  constructor(
    private readonly subscriptions: PushSubscriptionsService,
    private readonly push: WebPushTransport,
    private readonly fallback: FallbackWebhookTransport,
    private readonly config: ConfigService,
  ) {}

  /**
   * Deliver one approval. Never throws.
   *
   * Returns whether ANY transport accepted custody. `accepted` is not
   * `delivered` — the distinction `SendOutcome` exists to preserve — and this
   * path deliberately does not chase a receipt: receipts prove somebody was
   * told about a STALL, and an approval nobody opened is a question still
   * waiting in a queue, which is already visible as itself.
   */
  async send(approval: ApprovalForNotification): Promise<boolean> {
    try {
      const payload = buildApprovalPayload(
        approval,
        this.config.get<string>('appUrl') ?? '',
      );

      let accepted = false;

      try {
        if (this.push.isConfigured()) {
          for (const target of await this.subscriptions.targets()) {
            const outcome = await this.push.send(target, payload);
            accepted = accepted || outcome.accepted;
          }
        }
      } catch (error) {
        this.logger.warn(
          `Approval ${approval.id} push failed: ${message(error)}`,
        );
      }

      if (!accepted && this.fallback.isConfigured()) {
        try {
          const outcome = await this.fallback.send(WEBHOOK_TARGET, payload);
          accepted = accepted || outcome.accepted;
        } catch (error) {
          this.logger.warn(
            `Approval ${approval.id} webhook failed: ${message(error)}`,
          );
        }
      }

      if (!accepted) {
        // At `warn` and naming the approval, because this is the four-hours-
        // dead case in miniature: the question exists, the clock on it is
        // running (unless it is parked, in which case it is not running at
        // all), and nobody has been told. The row is still queryable, which is
        // what makes this recoverable rather than lost.
        this.logger.warn(
          `Approval ${approval.id} (${approval.actionClass}) was raised but ` +
            'no notification transport accepted it. It is in the approvals ' +
            'queue and will resolve by its recorded timeout policy ' +
            `("${approval.timeoutPolicy}") whether or not anyone sees it.`,
        );
      }

      return accepted;
    } catch (error) {
      // The outermost catch. Building the payload should not be able to throw
      // — it is a pure function over fields the row already has — but a
      // notifier that can propagate is a notifier that can fail a raise, and
      // the whole contract of this class is that it cannot.
      this.logger.error(
        `Approval ${approval.id} notification failed entirely: ${message(error)}`,
      );
      return false;
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
