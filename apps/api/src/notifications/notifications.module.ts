import { Module } from '@nestjs/common';

import { EscalationsModule } from '../escalations/escalations.module';
import { EscalationDispatcher } from './escalation-dispatcher.service';
import { FallbackWebhookTransport } from './fallback-webhook.transport';
import { NotificationsController } from './notifications.controller';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { WebPushTransport } from './web-push.transport';

/**
 * The last link in the chain VISION §1 complains about.
 *
 * Everything upstream can work perfectly — the watchdog notices in ninety
 * seconds, the escalation is recorded, the cockpit shows it — and detection
 * latency is still measured in hours if nobody is actually told.
 *
 * Two transports, and the second is not a retry of the first: #58 requires a
 * delivery failure escalate through a DIFFERENT path, because if the push
 * service is down or no device is subscribed, trying again produces the same
 * silence.
 */
@Module({
  imports: [EscalationsModule],
  controllers: [NotificationsController],
  providers: [
    WebPushTransport,
    FallbackWebhookTransport,
    PushSubscriptionsService,
    EscalationDispatcher,
  ],
  // The two transports are exported so the daily brief (#93) can reuse them
  // without minting an escalation to ride. VISION §8 defines the brief as the
  // things that did NOT warrant waking someone, and an escalation row for it
  // would inflate the lifecycle and the latency percentiles computed over it.
  exports: [
    EscalationDispatcher,
    PushSubscriptionsService,
    WebPushTransport,
    FallbackWebhookTransport,
  ],
})
export class NotificationsModule {}
