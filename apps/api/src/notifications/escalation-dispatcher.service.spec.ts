import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EscalationsService } from '../escalations/escalations.service';
import { PrismaService } from '../prisma/prisma.service';
import { makeOperatorSettings } from '../settings/operator-settings/operator-settings.test-double';
import {
  EscalationDispatcher,
  MAX_DELIVERY_ATTEMPTS,
} from './escalation-dispatcher.service';
import type { FallbackWebhookTransport } from './fallback-webhook.transport';
import type { PushSubscriptionsService } from './push-subscriptions.service';
import type { WebPushTransport } from './web-push.transport';

const NOW = new Date('2026-08-22T12:00:00Z');
const RECEIPT_TIMEOUT_MS = 120_000;

function escalationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'esc-1',
    kind: 'run_stalled',
    status: 'raised',
    summary: 'wo_opifex_312_a3f91c2_a1 stalled (marinoscar/opifex#312)',
    detail: 'silent for 12m, exceeding the 90s threshold',
    raisedAt: new Date(NOW.getTime() - 4_000),
    dispatchedAt: null,
    deliveredAt: null,
    receiptId: null,
    transport: null,
    failureReason: null,
    deliveryAttempts: 0,
    progressStoppedAt: new Date(NOW.getTime() - 12 * 60_000),
    run: {
      workOrder: {
        identity: 'wo_opifex_312_a3f91c2_a1',
        issueNumber: 312,
        repository: { owner: 'marinoscar', name: 'opifex' },
      },
    },
    ...overrides,
  };
}

const DEVICE = {
  id: 'sub-1',
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'k', auth: 'a' },
};

function fakePrisma(rows: Record<string, unknown>[]) {
  return {
    rows,
    escalation: {
      findMany: async ({ where }: any) =>
        rows.filter((row) => {
          if (where.status) {
            const wanted = where.status;
            if (typeof wanted === 'object' && 'in' in wanted) {
              if (!wanted.in.includes(row.status)) return false;
            } else if (row.status !== wanted) {
              return false;
            }
          }
          if (where.deliveryAttempts?.lt !== undefined) {
            if ((row.deliveryAttempts as number) >= where.deliveryAttempts.lt)
              return false;
          }
          if (where.deliveredAt === null && row.deliveredAt !== null)
            return false;
          if (where.dispatchedAt?.lt) {
            const at = row.dispatchedAt as Date | null;
            if (!at || at >= where.dispatchedAt.lt) return false;
          }
          return true;
        }),
      findFirst: async ({ where }: any) =>
        rows.find((row) => row.receiptId === where.receiptId) ?? null,
      update: async ({ where, data }: any) => {
        const row = rows.find((candidate) => candidate.id === where.id) as any;
        for (const [key, value] of Object.entries(data)) {
          row[key] =
            value &&
            typeof value === 'object' &&
            'increment' in (value as object)
              ? (row[key] ?? 0) + (value as { increment: number }).increment
              : value;
        }
        return row;
      },
    },
  };
}

describe('EscalationDispatcher', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let escalations: { markDelivered: jest.Mock };
  let subscriptions: {
    targets: jest.Mock;
    recordSuccess: jest.Mock;
    recordFailure: jest.Mock;
  };
  let push: { name: string; isConfigured: jest.Mock; send: jest.Mock };
  let fallback: { name: string; isConfigured: jest.Mock; send: jest.Mock };
  let dispatcher: EscalationDispatcher;

  function build(rows: Record<string, unknown>[] = [escalationRow()]) {
    prisma = fakePrisma(rows);
    dispatcher = new EscalationDispatcher(
      prisma as unknown as PrismaService,
      escalations as unknown as EscalationsService,
      subscriptions as unknown as PushSubscriptionsService,
      push as unknown as WebPushTransport,
      fallback as unknown as FallbackWebhookTransport,
      new ConfigService({ appUrl: 'https://opifex.test' }),
      makeOperatorSettings({
        overrides: { 'notifications.receiptTimeoutMs': RECEIPT_TIMEOUT_MS },
      }),
    );
    jest
      .spyOn(dispatcher['logger'], 'error')
      .mockImplementation(() => undefined);
    jest
      .spyOn(dispatcher['logger'], 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(dispatcher['logger'], 'log').mockImplementation(() => undefined);
    return dispatcher;
  }

  beforeEach(() => {
    escalations = { markDelivered: jest.fn().mockResolvedValue({}) };
    subscriptions = {
      targets: jest.fn().mockResolvedValue([DEVICE]),
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };
    push = {
      name: 'push',
      isConfigured: jest.fn().mockReturnValue(true),
      send: jest.fn().mockResolvedValue({
        targetId: DEVICE.id,
        accepted: true,
        gone: false,
        statusCode: 201,
      }),
    };
    fallback = {
      name: 'webhook',
      isConfigured: jest.fn().mockReturnValue(false),
      send: jest.fn(),
    };
    build();
  });

  describe('accepted is not delivered', () => {
    it('marks an accepted escalation DISPATCHED, not delivered', async () => {
      // #58: "An escalation that silently failed to send is indistinguishable
      // from no escalation." A push service answering 201 has taken custody of
      // a message; it has not made a phone ring. Collapsing the two would put
      // a green tick next to a notification nobody saw.
      await dispatcher.dispatchPending(NOW);

      expect(prisma.rows[0]).toMatchObject({
        status: 'dispatched',
        transport: 'push',
        dispatchedAt: NOW,
      });
      expect(prisma.rows[0].deliveredAt).toBeNull();
    });

    it('does not close the stop-to-notified measurement on acceptance', async () => {
      // #59 measures to a human being INFORMED. Recording it here would make
      // success metric 1 report the push service's latency instead.
      await dispatcher.dispatchPending(NOW);

      expect(escalations.markDelivered).not.toHaveBeenCalled();
    });

    it('issues an unguessable single-use receipt token', async () => {
      await dispatcher.dispatchPending(NOW);

      expect(prisma.rows[0].receiptId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('counts the attempt', async () => {
      await dispatcher.dispatchPending(NOW);

      expect(prisma.rows[0].deliveryAttempts).toBe(1);
    });
  });

  describe('the receipt', () => {
    it('turns dispatched into delivered', async () => {
      await dispatcher.dispatchPending(NOW);

      const result = await dispatcher.recordReceipt(
        prisma.rows[0].receiptId as string,
        NOW,
      );

      expect(result).toEqual({ escalationId: 'esc-1', recorded: true });
      expect(escalations.markDelivered).toHaveBeenCalledWith('esc-1', 'push', {
        receiptId: prisma.rows[0].receiptId,
        deliveredAt: NOW,
      });
    });

    it('keeps the FIRST receipt when two devices show the same notification', async () => {
      // Normal, not an error. The first is when the operator was informed;
      // re-recording would move success metric 1 later for no reason.
      await dispatcher.dispatchPending(NOW);
      const receiptId = prisma.rows[0].receiptId as string;
      await dispatcher.recordReceipt(receiptId, NOW);
      prisma.rows[0].deliveredAt = NOW;

      const second = await dispatcher.recordReceipt(
        receiptId,
        new Date(NOW.getTime() + 60_000),
      );

      expect(second.recorded).toBe(false);
      expect(escalations.markDelivered).toHaveBeenCalledTimes(1);
    });

    it('404s an unknown token', async () => {
      await expect(dispatcher.recordReceipt('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('gives the same answer for a wrong token as for an expired one', async () => {
      // A receipt endpoint that distinguished them would be an oracle for
      // guessing tokens, and it is a public endpoint by necessity.
      const unknown = await dispatcher
        .recordReceipt('a'.repeat(64))
        .catch((e) => e.message);
      const alsoUnknown = await dispatcher
        .recordReceipt('b'.repeat(64))
        .catch((e) => e.message);

      expect(unknown).toBe(alsoUnknown);
    });
  });

  describe('when nothing takes it', () => {
    beforeEach(() => {
      push.send.mockResolvedValue({
        targetId: DEVICE.id,
        accepted: false,
        gone: false,
        statusCode: 500,
        error: 'Internal Server Error',
      });
    });

    it('records FAILED rather than leaving it looking handled', async () => {
      const result = await dispatcher.dispatchPending(NOW);

      expect(result.failed).toBe(1);
      expect(prisma.rows[0].status).toBe('failed');
    });

    it('names the missing configuration when there is none', async () => {
      // Three genuinely different problems with three different fixes. A
      // single "delivery failed" leaves the operator to work out which, at
      // the moment they are least equipped to.
      push.isConfigured.mockReturnValue(false);

      await dispatcher.dispatchPending(NOW);

      expect(prisma.rows[0].failureReason).toContain('VAPID_PUBLIC_KEY');
    });

    it('says so plainly when no device is subscribed', async () => {
      subscriptions.targets.mockResolvedValue([]);

      await dispatcher.dispatchPending(NOW);

      expect(prisma.rows[0].failureReason).toContain(
        'No devices are subscribed',
      );
    });

    it("keeps the push service's own words when devices rejected it", async () => {
      await dispatcher.dispatchPending(NOW);

      expect(prisma.rows[0].failureReason).toContain(
        '500: Internal Server Error',
      );
    });
  });

  describe('re-routing through a different path', () => {
    beforeEach(() => {
      push.send.mockResolvedValue({
        targetId: DEVICE.id,
        accepted: false,
        gone: false,
        error: 'no',
      });
      fallback.isConfigured.mockReturnValue(true);
      fallback.send.mockResolvedValue({
        targetId: 'fallback-webhook',
        accepted: true,
        gone: false,
      });
    });

    it('sends through the fallback when Web Push would not', async () => {
      // #58: "a delivery failure must itself escalate through a different
      // path." Retrying the same transport is not a different path — if the
      // push service is down, trying again produces the same silence.
      const result = await dispatcher.dispatchPending(NOW);

      expect(result.rerouted).toBe(1);
      expect(prisma.rows[0]).toMatchObject({
        status: 'dispatched',
        transport: 'webhook',
      });
    });

    it('still records WHY the fallback was needed', async () => {
      // A successful fallback that erased the reason would hide that the
      // operator's phone is not working.
      await dispatcher.dispatchPending(NOW);

      expect(prisma.rows[0].failureReason).toContain(
        'Web Push did not deliver',
      );
    });

    it('falls through to failed when the fallback also refuses', async () => {
      fallback.send.mockResolvedValue({
        targetId: 'fallback-webhook',
        accepted: false,
        gone: false,
      });

      const result = await dispatcher.dispatchPending(NOW);

      expect(result.failed).toBe(1);
      expect(prisma.rows[0].status).toBe('failed');
    });

    it('does not try a fallback that is not configured', async () => {
      fallback.isConfigured.mockReturnValue(false);

      await dispatcher.dispatchPending(NOW);

      expect(fallback.send).not.toHaveBeenCalled();
      expect(prisma.rows[0].status).toBe('failed');
    });
  });

  describe('subscription health', () => {
    it('clears the failure streak on a send that worked', async () => {
      await dispatcher.dispatchPending(NOW);

      expect(subscriptions.recordSuccess).toHaveBeenCalledWith(DEVICE.id);
    });

    it('passes GONE through, so a dead subscription is pruned not retried', async () => {
      push.send.mockResolvedValue({
        targetId: DEVICE.id,
        accepted: false,
        gone: true,
        statusCode: 410,
      });

      await dispatcher.dispatchPending(NOW);

      expect(subscriptions.recordFailure).toHaveBeenCalledWith(DEVICE.id, true);
    });

    it('does not prune on a transient failure', async () => {
      push.send.mockResolvedValue({
        targetId: DEVICE.id,
        accepted: false,
        gone: false,
        statusCode: 429,
      });

      await dispatcher.dispatchPending(NOW);

      expect(subscriptions.recordFailure).toHaveBeenCalledWith(
        DEVICE.id,
        false,
      );
    });

    it('sends to every registered device, not just the first', async () => {
      const second = {
        ...DEVICE,
        id: 'sub-2',
        endpoint: 'https://push.example/def',
      };
      subscriptions.targets.mockResolvedValue([DEVICE, second]);

      await dispatcher.dispatchPending(NOW);

      expect(push.send).toHaveBeenCalledTimes(2);
    });

    it('dispatches when ANY device accepts', async () => {
      const second = { ...DEVICE, id: 'sub-2' };
      subscriptions.targets.mockResolvedValue([DEVICE, second]);
      push.send
        .mockResolvedValueOnce({
          targetId: DEVICE.id,
          accepted: false,
          gone: true,
        })
        .mockResolvedValueOnce({
          targetId: 'sub-2',
          accepted: true,
          gone: false,
        });

      await dispatcher.dispatchPending(NOW);

      expect(prisma.rows[0].status).toBe('dispatched');
    });
  });

  describe('sent and never confirmed', () => {
    it('fails an escalation whose receipt window expired', async () => {
      // The whole reason `dispatched` is a distinct status. Without this it
      // would sit looking handled forever — indistinguishable, from the
      // cockpit, from one an operator has seen.
      build([
        escalationRow({
          status: 'dispatched',
          dispatchedAt: new Date(NOW.getTime() - RECEIPT_TIMEOUT_MS - 1_000),
          receiptId: 'r1',
        }),
      ]);

      const result = await dispatcher.dispatchPending(NOW);

      expect(result.timedOut).toBe(1);
      expect(prisma.rows[0].status).toBe('failed');
      expect(prisma.rows[0].failureReason).toContain('no device confirmed');
    });

    it('leaves one still inside its window alone', async () => {
      build([
        escalationRow({
          status: 'dispatched',
          dispatchedAt: new Date(NOW.getTime() - 30_000),
          receiptId: 'r1',
        }),
      ]);

      await dispatcher.dispatchPending(NOW);

      expect(prisma.rows[0].status).toBe('dispatched');
    });

    it('never times out an escalation dispatched in this very pass', async () => {
      // Sweeping BEFORE sending would give every escalation dispatched this
      // pass a zero-length window on the next one.
      await dispatcher.dispatchPending(NOW);

      expect(prisma.rows[0].status).toBe('dispatched');
    });

    it('does not touch one a device already confirmed', async () => {
      build([
        escalationRow({
          status: 'dispatched',
          dispatchedAt: new Date(NOW.getTime() - RECEIPT_TIMEOUT_MS - 1_000),
          deliveredAt: new Date(NOW.getTime() - RECEIPT_TIMEOUT_MS),
          receiptId: 'r1',
        }),
      ]);

      const result = await dispatcher.dispatchPending(NOW);

      expect(result.timedOut).toBe(0);
    });
  });

  describe('the queue', () => {
    it('sends the oldest first, because its latency is already the worst', async () => {
      build([]);
      const findMany = jest.spyOn(prisma.escalation, 'findMany');

      await dispatcher.dispatchPending(NOW);

      expect(findMany.mock.calls[0][0].orderBy).toEqual({ raisedAt: 'asc' });
    });

    it('bounds one pass, so a backlog cannot monopolise the tick', async () => {
      build([]);
      const findMany = jest.spyOn(prisma.escalation, 'findMany');

      await dispatcher.dispatchPending(NOW);

      expect(findMany.mock.calls[0][0].take).toBe(25);
    });

    it.each(['acknowledged', 'resolved', 'delivered'])(
      'does not re-send a %s escalation',
      async (status) => {
        // A human already dealt with it, or a device already showed it.
        build([escalationRow({ status })]);

        const result = await dispatcher.dispatchPending(NOW);

        expect(result.dispatched).toBe(0);
        expect(push.send).not.toHaveBeenCalled();
      },
    );

    it('does not re-send one a transport already has custody of', async () => {
      // `dispatched` means a push service took it. Sending again would put
      // two notifications on the phone for one stall; sweepOverdue is what
      // deals with a dispatch that never arrived.
      build([
        escalationRow({
          status: 'dispatched',
          dispatchedAt: NOW,
          receiptId: 'r1',
        }),
      ]);

      await dispatcher.dispatchPending(NOW);

      expect(push.send).not.toHaveBeenCalled();
    });
  });

  describe('retrying what failed (#136)', () => {
    beforeEach(() => {
      push.send.mockResolvedValue({
        targetId: DEVICE.id,
        accepted: false,
        gone: false,
        statusCode: 500,
        error: 'Internal Server Error',
      });
    });

    it('tries a previously-failed escalation again', async () => {
      // The bug this fixes: an escalation went raised -> failed on the FIRST
      // failure and was never picked up again, so a push service that
      // returned a 500 for thirty seconds lost it permanently — the exact
      // failure #58 exists to eliminate, by a different route.
      build([escalationRow({ status: 'failed', deliveryAttempts: 1 })]);

      const result = await dispatcher.dispatchPending(NOW);

      expect(push.send).toHaveBeenCalled();
      expect(result.retried).toBe(1);
      expect(prisma.rows[0].deliveryAttempts).toBe(2);
    });

    it('delivers on a retry once the transport recovers', async () => {
      build([escalationRow({ status: 'failed', deliveryAttempts: 2 })]);
      push.send.mockResolvedValue({
        targetId: DEVICE.id,
        accepted: true,
        gone: false,
      });

      await dispatcher.dispatchPending(NOW);

      expect(prisma.rows[0]).toMatchObject({
        status: 'dispatched',
        transport: 'push',
      });
    });

    it('counts a first attempt as a first attempt, not a retry', async () => {
      const result = await dispatcher.dispatchPending(NOW);

      expect(result.retried).toBe(0);
    });

    it('gives up at the cap rather than retrying forever', async () => {
      build([
        escalationRow({
          status: 'failed',
          deliveryAttempts: MAX_DELIVERY_ATTEMPTS,
        }),
      ]);

      const result = await dispatcher.dispatchPending(NOW);

      expect(push.send).not.toHaveBeenCalled();
      expect(result.retried).toBe(0);
    });

    it('reports the attempt that hits the cap as abandoned', async () => {
      // Two different situations and two different log lines: one will be
      // tried again shortly, one never will.
      build([
        escalationRow({
          status: 'failed',
          deliveryAttempts: MAX_DELIVERY_ATTEMPTS - 1,
        }),
      ]);

      const result = await dispatcher.dispatchPending(NOW);

      expect(result.abandoned).toBe(1);
    });

    it('does not report a mid-sequence failure as abandoned', async () => {
      build([escalationRow({ status: 'failed', deliveryAttempts: 1 })]);

      const result = await dispatcher.dispatchPending(NOW);

      expect(result.abandoned).toBe(0);
      expect(result.failed).toBe(1);
    });

    it('leaves the row failed after the cap, which is the honest end state', async () => {
      // Nobody was told. GET /escalations/latency counts it under
      // awaitingNotification and the cockpit shows it.
      build([
        escalationRow({
          status: 'failed',
          deliveryAttempts: MAX_DELIVERY_ATTEMPTS - 1,
        }),
      ]);

      await dispatcher.dispatchPending(NOW);

      expect(prisma.rows[0].status).toBe('failed');
    });

    it('is bounded within the order of minutes at a normal tick interval', async () => {
      // The tick IS the backoff. At the default 60s interval the cap is
      // roughly five minutes of trying, which is the right order of magnitude
      // for a notification whose whole value is its latency.
      expect(MAX_DELIVERY_ATTEMPTS).toBeGreaterThanOrEqual(3);
      expect(MAX_DELIVERY_ATTEMPTS).toBeLessThanOrEqual(10);
    });
  });

  describe('what the device receives', () => {
    it("carries VISION §8's four fields and a one-tap link", async () => {
      await dispatcher.dispatchPending(NOW);

      const [, payload] = push.send.mock.calls[0];
      expect(payload).toMatchObject({
        title: 'Run stalled',
        body: escalationRow().summary,
        why: escalationRow().detail,
        kind: 'run_stalled',
        url: 'https://opifex.test/runs?issue=marinoscar/opifex%23312',
      });
      expect(payload.blastRadius.length).toBeGreaterThan(0);
      expect(payload.ifIgnored.length).toBeGreaterThan(0);
    });

    it('carries the same receipt token it stored', async () => {
      await dispatcher.dispatchPending(NOW);

      const [, payload] = push.send.mock.calls[0];
      expect(payload.receiptId).toBe(prisma.rows[0].receiptId);
    });
  });
});
