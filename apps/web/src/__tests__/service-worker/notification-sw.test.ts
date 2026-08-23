/**
 * The service worker is the only place the receipt actually gets sent, and it
 * is plain JavaScript in `public/` rather than a bundled module — so nothing
 * else in the suite would ever load it.
 *
 * Loaded here by evaluating the real file against a stubbed `self`. The
 * alternative, asserting nothing about it, leaves the one step that turns
 * `dispatched` into `delivered` completely untested — which is precisely the
 * gap #58 says makes a failed send indistinguishable from no send.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(
  resolve(__dirname, '../../../public/notification-sw.js'),
  'utf8',
);

type Listener = (event: Record<string, unknown>) => void;

function loadWorker() {
  const listeners = new Map<string, Listener>();

  const registration = {
    showNotification: vi.fn().mockResolvedValue(undefined),
  };
  const clients = {
    claim: vi.fn().mockResolvedValue(undefined),
    matchAll: vi.fn().mockResolvedValue([]),
    openWindow: vi.fn().mockResolvedValue(undefined),
  };

  const self = {
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, listener),
    skipWaiting: vi.fn(),
    registration,
    clients,
  };

  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 200 }));

  new Function('self', 'fetch', SOURCE)(self, fetchMock);

  return { listeners, registration, clients, self, fetchMock };
}

/** A push event whose `waitUntil` is awaitable, as the real one is not. */
function pushEvent(payload: unknown) {
  const pending: Promise<unknown>[] = [];
  return {
    event: {
      data: payload === undefined ? null : { json: () => payload },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    },
    settled: () => Promise.all(pending),
  };
}

const PAYLOAD = {
  escalationId: 'esc-1',
  receiptId: 'r'.repeat(64),
  title: 'Run stalled',
  body: 'wo_opifex_312_a3f91c2_a1 stalled (marinoscar/opifex#312)',
  why: 'silent for 12m, exceeding the 90s threshold',
  blastRadius: 'One run. Its work order stays open.',
  ifIgnored: 'No spend, no damage — just no progress.',
  url: 'https://opifex.test/runs?issue=marinoscar/opifex%23312',
  kind: 'run_stalled',
  raisedAt: '2026-08-22T12:00:00.000Z',
};

describe('notification service worker', () => {
  let worker: ReturnType<typeof loadWorker>;

  beforeEach(() => {
    worker = loadWorker();
  });

  describe('showing the notification', () => {
    it("renders all four of VISION §8's fields", async () => {
      const { event, settled } = pushEvent(PAYLOAD);

      worker.listeners.get('push')!(event);
      await settled();

      const [, options] = worker.registration.showNotification.mock.calls[0];
      for (const field of [
        PAYLOAD.body,
        PAYLOAD.why,
        PAYLOAD.blastRadius,
        PAYLOAD.ifIgnored,
      ]) {
        expect(options.body).toContain(field);
      }
    });

    it('leads with WHAT happened, since a locked phone shows only the first line', async () => {
      const { event, settled } = pushEvent(PAYLOAD);

      worker.listeners.get('push')!(event);
      await settled();

      const [title, options] =
        worker.registration.showNotification.mock.calls[0];
      expect(title).toBe('Run stalled');
      expect(options.body.startsWith(PAYLOAD.body)).toBe(true);
    });

    it('stays on screen until acted on', async () => {
      // An escalation that auto-dismisses while the operator is asleep is the
      // four-hours-dead case again.
      const { event, settled } = pushEvent(PAYLOAD);

      worker.listeners.get('push')!(event);
      await settled();

      expect(
        worker.registration.showNotification.mock.calls[0][1]
          .requireInteraction,
      ).toBe(true);
    });

    it('tags by escalation, so twelve pushes about one stall collapse', async () => {
      const { event, settled } = pushEvent(PAYLOAD);

      worker.listeners.get('push')!(event);
      await settled();

      expect(worker.registration.showNotification.mock.calls[0][1].tag).toBe(
        'esc-1',
      );
    });

    it('shows SOMETHING even for a payload it cannot parse', async () => {
      // A browser that receives a push and displays nothing may revoke the
      // subscription entirely, and "we stopped being able to tell you
      // anything" is far worse than one ugly notification.
      const { event, settled } = pushEvent(undefined);

      worker.listeners.get('push')!(event);
      await settled();

      expect(worker.registration.showNotification).toHaveBeenCalled();
    });
  });

  describe('the receipt', () => {
    it('posts the token back, which is what makes delivery a fact', async () => {
      const { event, settled } = pushEvent(PAYLOAD);

      worker.listeners.get('push')!(event);
      await settled();

      expect(worker.fetchMock).toHaveBeenCalledWith(
        '/api/notifications/receipts',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ receiptId: PAYLOAD.receiptId }),
        }),
      );
    });

    it('is awaited through waitUntil, not fired and forgotten', async () => {
      // A worker is terminated the moment its handler returns. A receipt sent
      // without waitUntil is killed in flight, and the escalation is then
      // recorded as failed despite having been shown.
      const { event, settled } = pushEvent(PAYLOAD);
      let resolveFetch: (value: Response) => void = () => undefined;
      worker.fetchMock.mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      );

      worker.listeners.get('push')!(event);
      let done = false;
      const waiting = settled().then(() => (done = true));

      await Promise.resolve();
      expect(done).toBe(false);

      resolveFetch(new Response(null, { status: 200 }));
      await waiting;
      expect(done).toBe(true);
    });

    it('does not lose the notification when the receipt fails', async () => {
      // It is already on screen. Throwing would lose that to no benefit, and
      // the server's own sweep records the unconfirmed escalation as failed —
      // the correct conservative outcome.
      worker.fetchMock.mockRejectedValue(new Error('offline'));
      const { event, settled } = pushEvent(PAYLOAD);

      worker.listeners.get('push')!(event);

      await expect(settled()).resolves.toBeDefined();
      expect(worker.registration.showNotification).toHaveBeenCalled();
    });

    it('sends nothing when there is no token to send', async () => {
      const { event, settled } = pushEvent({
        ...PAYLOAD,
        receiptId: undefined,
      });

      worker.listeners.get('push')!(event);
      await settled();

      expect(worker.fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('one tap', () => {
    it('focuses a tab already on the page rather than stacking another', async () => {
      const existing = { url: PAYLOAD.url, focus: vi.fn() };
      worker.clients.matchAll.mockResolvedValue([existing]);
      const pending: Promise<unknown>[] = [];

      worker.listeners.get('notificationclick')!({
        notification: { close: vi.fn(), data: { url: PAYLOAD.url } },
        waitUntil: (p: Promise<unknown>) => pending.push(p),
      });
      await Promise.all(pending);

      expect(existing.focus).toHaveBeenCalled();
      expect(worker.clients.openWindow).not.toHaveBeenCalled();
    });

    it('opens a window when nothing is on the page', async () => {
      const pending: Promise<unknown>[] = [];

      worker.listeners.get('notificationclick')!({
        notification: { close: vi.fn(), data: { url: PAYLOAD.url } },
        waitUntil: (p: Promise<unknown>) => pending.push(p),
      });
      await Promise.all(pending);

      expect(worker.clients.openWindow).toHaveBeenCalledWith(PAYLOAD.url);
    });

    it('closes the notification either way', async () => {
      const close = vi.fn();

      worker.listeners.get('notificationclick')!({
        notification: { close, data: {} },
        waitUntil: (p: Promise<unknown>) => p,
      });

      expect(close).toHaveBeenCalled();
    });
  });

  describe('taking over', () => {
    it('activates immediately rather than waiting for every tab to close', async () => {
      // An operator who just enabled notifications should be covered by the
      // version they enabled, not the one from their last visit.
      worker.listeners.get('install')!({});

      expect(worker.self.skipWaiting).toHaveBeenCalled();
    });

    it('claims open clients on activate', async () => {
      const pending: Promise<unknown>[] = [];
      worker.listeners.get('activate')!({
        waitUntil: (p: Promise<unknown>) => pending.push(p),
      });
      await Promise.all(pending);

      expect(worker.clients.claim).toHaveBeenCalled();
    });
  });
});
