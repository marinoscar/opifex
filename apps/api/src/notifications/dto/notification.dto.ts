import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createPushSubscriptionSchema = z.object({
  /** The push service URL the browser issued. */
  endpoint: z.url(),
  /** The subscription's public key, base64url, from `PushSubscription.getKey('p256dh')`. */
  p256dh: z.string().min(1),
  /** The auth secret, base64url, from `PushSubscription.getKey('auth')`. */
  auth: z.string().min(1),
  /** Optional label so an operator revoking a device can tell which it is. */
  userAgent: z.string().max(512).optional(),
});

export class CreatePushSubscriptionDto extends createZodDto(createPushSubscriptionSchema) {}

/**
 * Never includes `p256dh` or `auth`.
 *
 * They are the device's payload-encryption secrets. The browser already has
 * them; handing them back would turn a listing into a way to push arbitrary
 * content to somebody's phone.
 */
export const pushSubscriptionResponseSchema = z.object({
  id: z.uuid(),
  endpoint: z.string(),
  userAgent: z.string().nullable(),
  failureCount: z.number().int(),
  lastSuccessAt: z.iso.datetime().nullable(),
  lastFailureAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export class PushSubscriptionResponseDto extends createZodDto(pushSubscriptionResponseSchema) {}

export const notificationConfigResponseSchema = z.object({
  /**
   * The VAPID public key a browser needs to subscribe. Public by definition —
   * it is what the subscription is issued against.
   */
  vapidPublicKey: z.string(),
  /** False when the server has no VAPID keys: subscribing would be pointless. */
  pushConfigured: z.boolean(),
  /** Whether a second, independent path exists if Web Push fails. */
  fallbackConfigured: z.boolean(),
});

export class NotificationConfigResponseDto extends createZodDto(
  notificationConfigResponseSchema,
) {}

export const receiptSchema = z.object({
  /** The token the notification payload carried. */
  receiptId: z.string().min(32).max(128),
});

export class ReceiptDto extends createZodDto(receiptSchema) {}
