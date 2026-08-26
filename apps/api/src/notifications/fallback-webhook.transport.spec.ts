import { makeOperatorSettings } from '../settings/operator-settings/operator-settings.test-double';
import {
  FallbackWebhookTransport,
  WEBHOOK_TARGET,
} from './fallback-webhook.transport';
import type { NotificationPayload } from './notification-payload';

const PAYLOAD = {
  escalationId: 'esc-1',
  receiptId: 'r1',
  title: 'Run stalled',
  body: 'wo_opifex_312_a3f91c2_a1 stalled (marinoscar/opifex#312)',
  why: 'silent for 12m, exceeding the 90s threshold',
  blastRadius: 'One run. Its work order stays open.',
  ifIgnored: 'No spend, no damage — just no progress.',
  url: 'https://opifex.test/runs',
  kind: 'run_stalled',
  raisedAt: '2026-08-22T12:00:00.000Z',
  priority: 'high' as const,
} satisfies NotificationPayload;

function transport(url = 'https://ntfy.example/opifex') {
  const instance = new FallbackWebhookTransport(
    makeOperatorSettings({
      overrides: { 'notifications.fallbackWebhookUrl': url },
    }),
  );
  jest.spyOn(instance['logger'], 'log').mockImplementation(() => undefined);
  return instance;
}

describe('FallbackWebhookTransport', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => fetchMock.mockRestore());

  describe('opt-in', () => {
    it('is off unless a URL is set', () => {
      // It sends escalation text — repository names, issue numbers, failure
      // reasons — to a third party the operator chooses. Defaulting it on
      // would make that choice for them.
      expect(transport('').isConfigured()).toBe(false);
      expect(transport().isConfigured()).toBe(true);
    });

    it('reports itself unconfigured rather than pretending a path exists', async () => {
      const outcome = await transport('').send(WEBHOOK_TARGET, PAYLOAD);

      expect(outcome.accepted).toBe(false);
      expect(outcome.error).toContain('NOTIFY_FALLBACK_WEBHOOK_URL');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('what it posts', () => {
    it("carries all four of VISION §8's fields in one block", async () => {
      // A webhook receiver has no notification UI to lay four fields out in.
      await transport().send(WEBHOOK_TARGET, PAYLOAD);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      for (const field of [
        PAYLOAD.body,
        PAYLOAD.why,
        PAYLOAD.blastRadius,
        PAYLOAD.ifIgnored,
      ]) {
        expect(body.message).toContain(field);
      }
    });

    it('uses the title/message/priority shape ntfy and chat webhooks understand', async () => {
      await transport().send(WEBHOOK_TARGET, PAYLOAD);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body).toMatchObject({ title: 'Run stalled', priority: 'high' });
    });

    it('includes the one-tap link', async () => {
      await transport().send(WEBHOOK_TARGET, PAYLOAD);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.message).toContain(PAYLOAD.url);
    });

    it('does NOT leak the receipt token to a third party', async () => {
      // The receipt is a capability: whoever holds it can mark the escalation
      // delivered. A webhook receiver is not the device and has no business
      // confirming a notification it cannot display.
      await transport().send(WEBHOOK_TARGET, PAYLOAD);

      expect(fetchMock.mock.calls[0][1].body).not.toContain(PAYLOAD.receiptId);
    });
  });

  describe('failure', () => {
    it('is bounded, so a hanging receiver cannot stall the tick', async () => {
      // This runs on the reconciler loop. A webhook receiver that hangs must
      // not stop the loop that notices the NEXT stall.
      await transport().send(WEBHOOK_TARGET, PAYLOAD);

      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it('rejects a non-2xx as a failure, not a send', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

      const outcome = await transport().send(WEBHOOK_TARGET, PAYLOAD);

      expect(outcome).toMatchObject({ accepted: false, statusCode: 503 });
    });

    it('survives a network error', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      const outcome = await transport().send(WEBHOOK_TARGET, PAYLOAD);

      expect(outcome).toMatchObject({
        accepted: false,
        gone: false,
        error: 'ECONNREFUSED',
      });
    });

    it('never reports the webhook GONE', async () => {
      // "Gone" prunes a device. The webhook is configuration, not a
      // subscription, and deleting it is the operator's decision.
      fetchMock.mockResolvedValue(new Response(null, { status: 410 }));

      expect((await transport().send(WEBHOOK_TARGET, PAYLOAD)).gone).toBe(
        false,
      );
    });
  });
});
