import { Injectable, Logger } from '@nestjs/common';

import { OperatorSettingsService } from '../settings/operator-settings/operator-settings.service';
import type { NotificationPayload } from './notification-payload';
import type {
  NotificationTarget,
  NotificationTransport,
  SendOutcome,
} from './notification-transport';

/** The one synthetic target: the webhook itself, which has no device. */
export const WEBHOOK_TARGET: NotificationTarget = {
  id: 'fallback-webhook',
  endpoint: 'configured',
  keys: { p256dh: '', auth: '' },
};

/**
 * The second path, used only when Web Push could not deliver.
 *
 * #58 is explicit: *"a delivery failure must itself escalate through a
 * different path."* A retry of the same transport is not a different path —
 * if the push service is down, or the operator has no working subscription,
 * trying again produces the same silence.
 *
 * A generic POST rather than an ntfy or Slack client, so one seam covers
 * ntfy, a chat webhook, or a self-hosted receiver. The body carries the same
 * four fields VISION §8 requires, plus `message` and `title` in the shape
 * ntfy and most chat webhooks already understand.
 *
 * ## Off by default, and that is not laziness
 *
 * This sends escalation text — repository names, issue numbers, failure
 * reasons — to a third party the operator chooses. Defaulting it on would
 * make that choice for them. `NOTIFY_FALLBACK_WEBHOOK_URL` unset means this
 * transport reports itself unconfigured, and the dispatcher records that in
 * the failure reason rather than pretending a second path exists.
 */
@Injectable()
export class FallbackWebhookTransport implements NotificationTransport {
  readonly name = 'webhook';

  private readonly logger = new Logger(FallbackWebhookTransport.name);
  private readonly url: string;

  constructor(private readonly settings: OperatorSettingsService) {
    this.url = this.settings.get('notifications.fallbackWebhookUrl');
  }

  isConfigured(): boolean {
    return this.url.length > 0;
  }

  async send(
    target: NotificationTarget,
    payload: NotificationPayload,
  ): Promise<SendOutcome> {
    if (!this.isConfigured()) {
      return {
        targetId: target.id,
        accepted: false,
        gone: false,
        error:
          'No fallback transport is configured (NOTIFY_FALLBACK_WEBHOOK_URL)',
      };
    }

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: payload.title,
          // One block, because a webhook receiver has no notification UI to
          // lay four fields out in. The order is the order an operator reads
          // in: what, why, what it touches, what happens if they roll over.
          message:
            `${payload.body}\n\n` +
            `Why: ${payload.why}\n` +
            `Blast radius: ${payload.blastRadius}\n` +
            `If ignored: ${payload.ifIgnored}\n\n` +
            `${payload.url}`,
          priority: payload.priority,
          escalationId: payload.escalationId,
          kind: payload.kind,
          raisedAt: payload.raisedAt,
        }),
        // Bounded, because this runs on the reconciler tick. A webhook
        // receiver that hangs must not stall the loop that notices the NEXT
        // stall.
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return {
          targetId: target.id,
          accepted: false,
          gone: false,
          statusCode: response.status,
          error: `Fallback webhook returned ${response.status}`,
        };
      }

      this.logger.log(
        `${payload.escalationId ? `Escalation ${payload.escalationId}` : payload.kind} ` +
          'sent via the fallback webhook',
      );
      return {
        targetId: target.id,
        accepted: true,
        gone: false,
        statusCode: response.status,
      };
    } catch (error) {
      return {
        targetId: target.id,
        accepted: false,
        gone: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
