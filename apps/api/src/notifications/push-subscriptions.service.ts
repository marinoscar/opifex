import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { NotificationTarget } from './notification-transport';

/**
 * How many consecutive failures before a subscription is considered dead.
 *
 * A subscription the push service says is `gone` is pruned immediately; this
 * is for the other kind — one that keeps failing for reasons nobody can see.
 * Five is deliberately forgiving: pruning the operator's only phone because a
 * push service had a bad hour is a worse outcome than carrying a dead row.
 */
export const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * The devices an operator can be reached on.
 *
 * Scoped to the current user throughout — there is no cross-user read here,
 * even for an admin. A push subscription is a handle on someone's phone, and
 * VISION §11's single operator does not need an endpoint that hands one
 * account's devices to another.
 */
@Injectable()
export class PushSubscriptionsService {
  private readonly logger = new Logger(PushSubscriptionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register a device, or refresh the one already at this endpoint.
   *
   * Upserted on `endpoint` rather than inserted: a browser that re-subscribes
   * with the same key material gets the same endpoint back, and a second row
   * would push twice to one phone. The upsert also resets `failureCount` —
   * a browser that just handed us a fresh subscription is, by construction,
   * working again.
   */
  async subscribe(
    userId: string,
    input: { endpoint: string; p256dh: string; auth: string; userAgent?: string },
  ) {
    const subscription = await this.prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
      },
      update: {
        // Re-pointed at whoever is subscribing NOW. A shared machine changing
        // hands must not keep notifying the previous operator.
        userId,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
        failureCount: 0,
        lastFailureAt: null,
      },
    });

    this.logger.log(`Push subscription registered for user ${userId}`);
    return toResponse(subscription);
  }

  async list(userId: string) {
    const items = await this.prisma.pushSubscription.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return { items: items.map(toResponse), total: items.length };
  }

  async unsubscribe(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.pushSubscription.deleteMany({
      // `userId` in the WHERE rather than a read-then-check, so one user
      // cannot delete another's device even by guessing an id.
      where: { id, userId },
    });

    if (count === 0) {
      throw new NotFoundException(`Push subscription ${id} not found`);
    }
  }

  /**
   * Every device that should be notified.
   *
   * VISION §11 designs for a single operator, so this is deliberately "every
   * registered device" rather than a routing rule. Routing to the right
   * person is a problem this system does not have yet, and inventing it now
   * would be a config surface with nothing behind it.
   */
  async targets(): Promise<NotificationTarget[]> {
    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { failureCount: { lt: MAX_CONSECUTIVE_FAILURES } },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });

    return subscriptions.map((subscription) => ({
      id: subscription.id,
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    }));
  }

  /** A send worked: clear the failure streak. */
  async recordSuccess(id: string): Promise<void> {
    await this.prisma.pushSubscription.updateMany({
      where: { id },
      data: { failureCount: 0, lastSuccessAt: new Date(), lastFailureAt: null },
    });
  }

  /** A send failed, and may or may not be worth trying again. */
  async recordFailure(id: string, gone: boolean): Promise<void> {
    if (gone) {
      // The push service said this subscription no longer exists. Keeping it
      // would mean every future escalation counts a guaranteed failure and
      // the real devices' results get lost in the noise.
      await this.prisma.pushSubscription.deleteMany({ where: { id } });
      this.logger.log(`Pruned a push subscription the push service reported gone`);
      return;
    }

    await this.prisma.pushSubscription.updateMany({
      where: { id },
      data: { failureCount: { increment: 1 }, lastFailureAt: new Date() },
    });
  }
}

type SubscriptionRow = Awaited<
  ReturnType<PrismaService['pushSubscription']['findUniqueOrThrow']>
>;

/**
 * Never returns `p256dh` or `auth`.
 *
 * They are the device's payload-encryption secrets. The browser already has
 * them; nothing else needs them, and an endpoint that hands them back would
 * turn a listing into a way to push arbitrary content to someone's phone.
 */
function toResponse(subscription: SubscriptionRow) {
  return {
    id: subscription.id,
    endpoint: subscription.endpoint,
    userAgent: subscription.userAgent,
    failureCount: subscription.failureCount,
    lastSuccessAt: subscription.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: subscription.lastFailureAt?.toISOString() ?? null,
    createdAt: subscription.createdAt.toISOString(),
  };
}
