import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import {
  CreatePushSubscriptionDto,
  NotificationConfigResponseDto,
  PushSubscriptionResponseDto,
  ReceiptDto,
} from './dto/notification.dto';
import { EscalationDispatcher } from './escalation-dispatcher.service';
import { FallbackWebhookTransport } from './fallback-webhook.transport';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { WebPushTransport } from './web-push.transport';

/**
 * The devices an operator can be reached on, and the receipts they send back.
 *
 * No permission beyond being signed in. Managing your own phone is the same
 * class of thing as managing your own settings, and a viewer watching the
 * factory has as much reason to be told a run stalled as anyone — VISION §11
 * has one operator, and a permission here would only ever lock them out.
 */
@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly subscriptions: PushSubscriptionsService,
    private readonly dispatcher: EscalationDispatcher,
    private readonly push: WebPushTransport,
    private readonly fallback: FallbackWebhookTransport,
  ) {}

  @Get('config')
  @Auth()
  @ApiOperation({
    summary: 'What the browser needs in order to subscribe',
    description:
      'Returns the VAPID public key, plus whether each transport is configured at all. The ' +
      'UI uses `pushConfigured` to say "notifications are not set up on this server" rather ' +
      'than offering a button that silently does nothing.',
  })
  @ApiDataResponse(NotificationConfigResponseDto, { description: 'Notification configuration' })
  config() {
    return {
      vapidPublicKey: this.push.getPublicKey(),
      pushConfigured: this.push.isConfigured(),
      fallbackConfigured: this.fallback.isConfigured(),
    };
  }

  @Get('subscriptions')
  @Auth()
  @ApiOperation({ summary: "List the current user's registered devices" })
  @ApiDataResponse(PushSubscriptionResponseDto, {
    isArray: true,
    description: 'Registered devices',
  })
  list(@CurrentUser('id') userId: string) {
    return this.subscriptions.list(userId);
  }

  @Post('subscriptions')
  @Auth()
  @ApiOperation({
    summary: 'Register a device for push notifications',
    description:
      'Idempotent on the endpoint: a browser re-subscribing with the same key material gets ' +
      'the same endpoint back, and a second row for it would push twice to one phone.',
  })
  @ApiDataResponse(PushSubscriptionResponseDto, { description: 'The registered device' })
  subscribe(@CurrentUser('id') userId: string, @Body() body: CreatePushSubscriptionDto) {
    return this.subscriptions.subscribe(userId, body);
  }

  @Delete('subscriptions/:id')
  @Auth()
  @HttpCode(204)
  @ApiOperation({ summary: 'Stop notifying a device' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Removed' })
  @ApiResponse({ status: 404, description: 'Not one of your devices' })
  async unsubscribe(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.subscriptions.unsubscribe(userId, id);
  }

  /**
   * The device confirming it actually showed a notification.
   *
   * Public, because a service worker has no session. The receipt token is the
   * credential: 32 random bytes, carried inside an end-to-end encrypted push
   * payload, and it grants exactly one thing — marking one escalation
   * delivered. The alternative is storing a bearer token where a service
   * worker can read it, which is a strictly worse credential.
   */
  @Post('receipts')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirm a notification reached a device',
    description:
      'Web Push gives no delivery guarantee — a 201 from a push service means it accepted ' +
      'custody, not that a phone rang. This is what turns `dispatched` into `delivered`, and ' +
      'closes the stop-to-notified measurement (#59).',
  })
  @ApiResponse({ status: 200, description: 'Receipt recorded' })
  @ApiResponse({ status: 404, description: 'Unknown receipt' })
  receipt(@Body() body: ReceiptDto) {
    return this.dispatcher.recordReceipt(body.receiptId);
  }
}
