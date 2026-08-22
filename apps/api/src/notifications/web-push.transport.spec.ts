import { ConfigService } from '@nestjs/config';
import webpush from 'web-push';

import type { NotificationPayload } from './notification-payload';
import { WebPushTransport } from './web-push.transport';

jest.mock('web-push', () => ({
  __esModule: true,
  default: { setVapidDetails: jest.fn(), sendNotification: jest.fn() },
}));

const mocked = webpush as jest.Mocked<typeof webpush>;

const TARGET = {
  id: 'sub-1',
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'k', auth: 'a' },
};

const PAYLOAD = {
  escalationId: 'esc-1',
  receiptId: 'r1',
  title: 'Run stalled',
  body: 'wo stalled',
  why: 'silent for 12m',
  blastRadius: 'One run.',
  ifIgnored: 'No spend.',
  url: 'https://opifex.test/runs',
  kind: 'run_stalled',
  raisedAt: '2026-08-22T12:00:00.000Z',
} satisfies NotificationPayload;

function transport(env: Record<string, unknown> = {}) {
  const instance = new WebPushTransport(
    new ConfigService({
      notifications: {
        vapidPublicKey: 'pub',
        vapidPrivateKey: 'priv',
        vapidSubject: 'mailto:ops@example.com',
        ...env,
      },
    }),
  );
  // `logger` is an INSTANCE property, so it has to be silenced per instance —
  // a prototype spy here would quietly attach to nothing.
  jest.spyOn(instance['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(instance['logger'], 'log').mockImplementation(() => undefined);
  return instance;
}

describe('WebPushTransport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mocked.sendNotification.mockResolvedValue({ statusCode: 201 } as never);
  });

  describe('configuration', () => {
    it('is configured only when all three VAPID values are present', () => {
      expect(transport().isConfigured()).toBe(true);
      expect(transport({ vapidPrivateKey: '' }).isConfigured()).toBe(false);
      expect(transport({ vapidSubject: '' }).isConfigured()).toBe(false);
      expect(transport({ vapidPublicKey: '' }).isConfigured()).toBe(false);
    });

    it('refuses to send rather than failing obscurely when unconfigured', async () => {
      // Asked rather than discovered by failing: an unconfigured install
      // should record a reason naming the missing variables, not a stack
      // trace nobody reads.
      const outcome = await transport({ vapidPrivateKey: '' }).send(TARGET, PAYLOAD);

      expect(outcome.accepted).toBe(false);
      expect(outcome.error).toContain('VAPID_PRIVATE_KEY');
      expect(mocked.sendNotification).not.toHaveBeenCalled();
    });

    it('exposes the public key, which is public by definition', () => {
      expect(transport().getPublicKey()).toBe('pub');
    });
  });

  describe('sending', () => {
    it('reports ACCEPTED, which is not delivered', async () => {
      const outcome = await transport().send(TARGET, PAYLOAD);

      expect(outcome).toMatchObject({ targetId: 'sub-1', accepted: true, statusCode: 201 });
    });

    it('sends the payload the device needs to render all four fields', async () => {
      await transport().send(TARGET, PAYLOAD);

      const [, body] = mocked.sendNotification.mock.calls[0];
      expect(JSON.parse(body as string)).toEqual(PAYLOAD);
    });

    it('sends at HIGH urgency', async () => {
      // A push service may hold `normal` traffic to spare a sleeping phone's
      // battery. That is exactly the wrong trade-off for the one class of
      // message this whole system exists to send.
      const [, , options] = (await transport().send(TARGET, PAYLOAD),
      mocked.sendNotification.mock.calls[0]);

      expect(options).toMatchObject({ urgency: 'high' });
    });

    it('expires the message rather than letting it arrive an hour late', async () => {
      // A stall notification that arrives long after the fact is worse than
      // none: the operator acts on a state that has moved on.
      const [, , options] = (await transport().send(TARGET, PAYLOAD),
      mocked.sendNotification.mock.calls[0]);

      expect((options as { TTL: number }).TTL).toBeLessThanOrEqual(300);
    });
  });

  describe('failure', () => {
    it.each([404, 410])('treats %s as GONE, so the subscription is pruned', async (statusCode) => {
      mocked.sendNotification.mockRejectedValue(
        Object.assign(new Error('Gone'), { statusCode }),
      );

      expect((await transport().send(TARGET, PAYLOAD)).gone).toBe(true);
    });

    it.each([429, 500, 503])('treats %s as transient, NOT gone', async (statusCode) => {
      // Pruning on these would silently reduce the operator to no devices
      // after one bad afternoon at the push service.
      mocked.sendNotification.mockRejectedValue(
        Object.assign(new Error('Nope'), { statusCode }),
      );

      const outcome = await transport().send(TARGET, PAYLOAD);

      expect(outcome.gone).toBe(false);
      expect(outcome.accepted).toBe(false);
    });

    it("keeps the push service's own message", async () => {
      // "410 Gone" and "429 Too Many Requests" call for different responses;
      // a flattened error hides which happened.
      mocked.sendNotification.mockRejectedValue(
        Object.assign(new Error('Too Many Requests'), { statusCode: 429 }),
      );

      const outcome = await transport().send(TARGET, PAYLOAD);

      expect(outcome.error).toContain('Too Many Requests');
      expect(outcome.statusCode).toBe(429);
    });

    it('survives an error with no status at all', async () => {
      // A DNS failure or a socket reset has no HTTP status. Treating that as
      // gone would prune a live subscription over a network blip.
      mocked.sendNotification.mockRejectedValue(new Error('ECONNRESET'));

      const outcome = await transport().send(TARGET, PAYLOAD);

      expect(outcome).toMatchObject({ accepted: false, gone: false, error: 'ECONNRESET' });
      expect(outcome.statusCode).toBeUndefined();
    });
  });
});
