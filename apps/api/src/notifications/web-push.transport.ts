import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webpush from 'web-push';

import type { NotificationPayload } from './notification-payload';
import type {
  NotificationTarget,
  NotificationTransport,
  SendOutcome,
} from './notification-transport';

/**
 * Statuses meaning "this subscription will never work again".
 *
 * RFC 8030: 404 is an unknown subscription, 410 is one the user agent has
 * revoked. Anything else — 429, 500, a timeout — may be transient, and
 * pruning on those would silently reduce the operator to no devices after one
 * bad afternoon at the push service.
 */
const GONE_STATUSES = new Set([404, 410]);

/**
 * Web Push (RFC 8030) with VAPID (RFC 8292).
 *
 * Chosen over ntfy and Pushover in
 * `docs/adr/0004-notification-transport.md`. The short version: no
 * third-party account, no per-vendor credential, and the payload is encrypted
 * end to end so the push service relays bytes it cannot read — which is what
 * makes it acceptable to put escalation detail in the body rather than a
 * "something happened, open the app" stub.
 *
 * ## What this transport does NOT provide
 *
 * A delivery guarantee. A 201 means the push service accepted custody. It
 * does not mean a phone rang. The device posts a receipt back through
 * `POST /notifications/receipts`, and a dispatched escalation with no receipt
 * is treated as undelivered — see `EscalationDispatcher`.
 */
@Injectable()
export class WebPushTransport implements NotificationTransport {
  readonly name = 'push';

  private readonly logger = new Logger(WebPushTransport.name);
  private readonly publicKey: string;
  private readonly privateKey: string;
  private readonly subject: string;

  constructor(private readonly config: ConfigService) {
    this.publicKey =
      this.config.get<string>('notifications.vapidPublicKey') ?? '';
    this.privateKey =
      this.config.get<string>('notifications.vapidPrivateKey') ?? '';
    this.subject = this.config.get<string>('notifications.vapidSubject') ?? '';

    if (this.isConfigured()) {
      webpush.setVapidDetails(this.subject, this.publicKey, this.privateKey);
      this.logger.log('Web Push transport configured');
    } else {
      // At `warn`, and naming the variables. An install with no notification
      // transport is the failure #58 exists to close, so it should not be
      // discoverable only by a run stalling on a weekend.
      this.logger.warn(
        'Web Push transport is NOT configured (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, ' +
          'VAPID_SUBJECT). Escalations will be recorded and will NOT reach a phone.',
      );
    }
  }

  isConfigured(): boolean {
    return Boolean(this.publicKey && this.privateKey && this.subject);
  }

  /** The key a browser needs to subscribe. Public by definition. */
  getPublicKey(): string {
    return this.publicKey;
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
          'Web Push is not configured: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT ' +
          'must all be set',
      };
    }

    try {
      const response = await webpush.sendNotification(
        { endpoint: target.endpoint, keys: target.keys },
        JSON.stringify(payload),
        {
          // Urgency `high`: this is the one class of message the whole system
          // exists to send. A push service may hold `normal` traffic to save
          // a sleeping phone's battery, which is precisely the wrong
          // trade-off here.
          urgency: 'high',
          // If the phone is offline, keep it for the receipt window and no
          // longer. A stall notification that arrives an hour late is worse
          // than none: the operator acts on a state that has moved on.
          TTL: 300,
        },
      );

      return {
        targetId: target.id,
        accepted: true,
        gone: false,
        statusCode: response.statusCode,
      };
    } catch (error) {
      const statusCode = readStatus(error);

      return {
        targetId: target.id,
        accepted: false,
        gone: statusCode !== undefined && GONE_STATUSES.has(statusCode),
        statusCode,
        // The push service's own message, kept rather than replaced with a
        // generic one: "410 Gone" and "429 Too Many Requests" call for
        // different responses and a flattened error hides which happened.
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function readStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const status = (error as { statusCode: unknown }).statusCode;
    if (typeof status === 'number') return status;
  }
  return undefined;
}
