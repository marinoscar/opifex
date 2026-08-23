import { NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  MAX_CONSECUTIVE_FAILURES,
  PushSubscriptionsService,
} from './push-subscriptions.service';

const USER = 'user-1';
const OTHER_USER = 'user-2';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    userId: USER,
    endpoint: 'https://push.example/abc',
    p256dh: 'key',
    auth: 'secret',
    userAgent: 'iPhone',
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    createdAt: new Date('2026-08-22T10:00:00Z'),
    updatedAt: new Date('2026-08-22T10:00:00Z'),
    ...overrides,
  };
}

describe('PushSubscriptionsService', () => {
  let prisma: {
    pushSubscription: {
      upsert: jest.Mock;
      findMany: jest.Mock;
      deleteMany: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let service: PushSubscriptionsService;

  beforeEach(() => {
    prisma = {
      pushSubscription: {
        upsert: jest.fn().mockResolvedValue(row()),
        findMany: jest.fn().mockResolvedValue([row()]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new PushSubscriptionsService(prisma as unknown as PrismaService);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  });

  describe('registering a device', () => {
    it('upserts on the endpoint, not the id', async () => {
      // The endpoint IS the device's identity in the Web Push protocol: a
      // browser re-subscribing gets the same one back, and a second row for
      // it would push twice to one phone.
      await service.subscribe(USER, {
        endpoint: 'https://push.example/abc',
        p256dh: 'key',
        auth: 'secret',
      });

      const [{ where }] = prisma.pushSubscription.upsert.mock.calls[0];
      expect(where).toEqual({ endpoint: 'https://push.example/abc' });
    });

    it('clears the failure streak, because a fresh subscription is working', async () => {
      await service.subscribe(USER, { endpoint: 'e', p256dh: 'k', auth: 'a' });

      const [{ update }] = prisma.pushSubscription.upsert.mock.calls[0];
      expect(update).toMatchObject({ failureCount: 0, lastFailureAt: null });
    });

    it('re-points a shared machine at whoever is subscribing now', async () => {
      // A machine changing hands must not keep notifying the previous
      // operator.
      await service.subscribe(OTHER_USER, {
        endpoint: 'e',
        p256dh: 'k',
        auth: 'a',
      });

      const [{ update }] = prisma.pushSubscription.upsert.mock.calls[0];
      expect(update.userId).toBe(OTHER_USER);
    });

    it('NEVER returns the encryption secrets', async () => {
      // The browser already has them. Handing them back would turn a listing
      // into a way to push arbitrary content to somebody's phone.
      const result = await service.subscribe(USER, {
        endpoint: 'e',
        p256dh: 'k',
        auth: 'a',
      });

      expect(result).not.toHaveProperty('p256dh');
      expect(result).not.toHaveProperty('auth');
    });
  });

  describe('listing', () => {
    it('scopes to the current user, with no cross-user read at all', async () => {
      // Not even for an admin: a push subscription is a handle on somebody's
      // phone, and VISION §11's single operator has no need for an endpoint
      // that hands one account's devices to another.
      await service.list(USER);

      const [{ where }] = prisma.pushSubscription.findMany.mock.calls[0];
      expect(where).toEqual({ userId: USER });
    });

    it('returns no secrets here either', async () => {
      const { items } = await service.list(USER);

      expect(items[0]).not.toHaveProperty('auth');
      expect(items[0]).toHaveProperty('userAgent', 'iPhone');
    });
  });

  describe('removing a device', () => {
    it('scopes the delete by user, rather than reading then checking', async () => {
      // So one user cannot delete another's device even by guessing an id.
      await service.unsubscribe(USER, 'sub-1');

      const [{ where }] = prisma.pushSubscription.deleteMany.mock.calls[0];
      expect(where).toEqual({ id: 'sub-1', userId: USER });
    });

    it('404s when it deleted nothing', async () => {
      prisma.pushSubscription.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.unsubscribe(USER, 'sub-9')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('choosing targets', () => {
    it('skips subscriptions that have failed too many times running', async () => {
      await service.targets();

      const [{ where }] = prisma.pushSubscription.findMany.mock.calls[0];
      expect(where).toEqual({ failureCount: { lt: MAX_CONSECUTIVE_FAILURES } });
    });

    it('is forgiving, because pruning the only phone is the worse outcome', async () => {
      expect(MAX_CONSECUTIVE_FAILURES).toBeGreaterThanOrEqual(3);
    });

    it('notifies every registered device, not a routed subset', async () => {
      // VISION §11 has one operator. Routing to the right person is a problem
      // this system does not have yet, and inventing it now would be a config
      // surface with nothing behind it.
      prisma.pushSubscription.findMany.mockResolvedValue([
        row(),
        row({ id: 'sub-2', userId: OTHER_USER }),
      ]);

      expect(await service.targets()).toHaveLength(2);
    });

    it('hands the transport the key material it needs', async () => {
      const [target] = await service.targets();

      expect(target).toEqual({
        id: 'sub-1',
        endpoint: 'https://push.example/abc',
        keys: { p256dh: 'key', auth: 'secret' },
      });
    });
  });

  describe('recording what happened', () => {
    it('clears the streak on success', async () => {
      await service.recordSuccess('sub-1');

      const [{ data }] = prisma.pushSubscription.updateMany.mock.calls[0];
      expect(data).toMatchObject({ failureCount: 0, lastFailureAt: null });
    });

    it('deletes a subscription the push service reported GONE', async () => {
      // Keeping it would mean every future escalation counts a guaranteed
      // failure, and the real devices' results get lost in the noise.
      await service.recordFailure('sub-1', true);

      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
      });
      expect(prisma.pushSubscription.updateMany).not.toHaveBeenCalled();
    });

    it('only counts a transient failure', async () => {
      await service.recordFailure('sub-1', false);

      expect(prisma.pushSubscription.deleteMany).not.toHaveBeenCalled();
      const [{ data }] = prisma.pushSubscription.updateMany.mock.calls[0];
      expect(data.failureCount).toEqual({ increment: 1 });
    });
  });
});
