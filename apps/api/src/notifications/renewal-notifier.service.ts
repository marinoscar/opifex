import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  FallbackWebhookTransport,
  WEBHOOK_TARGET,
} from './fallback-webhook.transport';
import { PushSubscriptionsService } from './push-subscriptions.service';
import {
  buildRenewalPayload,
  type GrantForRenewalNotification,
} from './renewal-payload';
import { WebPushTransport } from './web-push.transport';

/**
 * Puts an expiring trust grant on the operator's phone (#115, VISION §8).
 *
 * ## Its own service, for the reason `ApprovalNotifier` is its own service
 *
 * `EscalationDispatcher` is a LIFECYCLE machine defined over an `Escalation`
 * row: it moves rows between `raised`, `dispatched`, `delivered` and `failed`,
 * retries, prunes gone subscriptions and mints receipt tokens. A grant nearing
 * expiry has no such row and must not be given one — that would put a routine,
 * safe-by-default event into the stop-to-notified percentiles VISION success
 * metric 1 computes over escalations, which measure how long a BROKEN RUN went
 * unnoticed. Nothing is broken here. So this rides the same
 * `NotificationTransport` seam directly, exactly as `ApprovalNotifier` and
 * `DailyBriefService` do.
 *
 * ## Push first, webhook second
 *
 * Same order and same seam as everything else in this directory, so a
 * deployment configured for escalations is configured for renewal prompts with
 * no extra variables. The webhook is a DIFFERENT PATH rather than a retry
 * (#58): if the push service is down or no device is subscribed, trying push
 * again produces the same silence.
 *
 * ## Nothing here throws
 *
 * `send` returns a boolean and swallows everything. A renewal prompt is an
 * optimisation on top of a mechanism that is already safe without it — the
 * grant lapses if nobody acts, which is the correct default — so a notifier
 * that could propagate would let a transport outage take down an hourly cron
 * for no gain.
 */
@Injectable()
export class RenewalNotifier {
  private readonly logger = new Logger(RenewalNotifier.name);

  constructor(
    private readonly subscriptions: PushSubscriptionsService,
    private readonly push: WebPushTransport,
    private readonly fallback: FallbackWebhookTransport,
    private readonly config: ConfigService,
  ) {}

  /**
   * Deliver one renewal prompt. Never throws.
   *
   * Returns whether ANY transport accepted custody. `accepted` is not
   * `delivered` — the distinction `SendOutcome` exists to preserve — and this
   * path deliberately does not chase a receipt: a receipt proves somebody was
   * told about a STALL, and an unread renewal prompt resolves itself by the
   * grant lapsing, which is the outcome the prompt was offering to avoid
   * rather than a failure to detect anything.
   */
  async send(grant: GrantForRenewalNotification, now: Date): Promise<boolean> {
    try {
      const payload = buildRenewalPayload(
        grant,
        this.config.get<string>('appUrl') ?? '',
        now,
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
          `Renewal prompt for grant ${grant.id} push failed: ${message(error)}`,
        );
      }

      if (!accepted && this.fallback.isConfigured()) {
        try {
          const outcome = await this.fallback.send(WEBHOOK_TARGET, payload);
          accepted = accepted || outcome.accepted;
        } catch (error) {
          this.logger.warn(
            `Renewal prompt for grant ${grant.id} webhook failed: ` +
              message(error),
          );
        }
      }

      if (!accepted) {
        // At `log`, not `warn`, and the difference from `ApprovalNotifier` is
        // deliberate. An undelivered approval leaves a question sitting in a
        // queue with a clock on it. An undelivered renewal prompt leaves a
        // grant that will lapse — the safe outcome, chosen by default. Worth
        // recording; not worth a warning that competes with real ones.
        this.logger.log(
          `Renewal prompt for grant ${grant.id} (${grant.actionClass}) was ` +
            'not accepted by any transport. The grant still expires at ' +
            `${grant.expiresAt.toISOString()} whether or not anyone sees ` +
            'this, and it is reported in the daily trust digest.',
        );
      }

      return accepted;
    } catch (error) {
      // The outermost catch. Building the payload is a pure function over
      // fields the caller already holds and should not be able to throw; kept
      // because "never throws" is a claim about code somebody else will edit.
      this.logger.error(
        `Renewal prompt for grant ${grant.id} failed entirely: ` +
          message(error),
      );
      return false;
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
