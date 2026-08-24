import { ConfigService } from '@nestjs/config';

import type { FallbackWebhookTransport } from '../../notifications/fallback-webhook.transport';
import type { PushSubscriptionsService } from '../../notifications/push-subscriptions.service';
import type { WebPushTransport } from '../../notifications/web-push.transport';
import type { DecisionLogService } from '../decision-log/decision-log.service';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { SnapshotInput } from '../snapshot/snapshot.types';
import { DailyBriefService } from './daily-brief.service';

const NOW = new Date('2026-08-24T08:00:00.000Z');

function state(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    generatedAt: NOW,
    windowDays: 1,
    totals: {
      runsRunning: 0,
      runsStalled: 0,
      runsBlocked: 0,
      runsSucceededInWindow: 3,
      runsFailedInWindow: 0,
      workOrdersQueued: 0,
      workOrdersHeld: 0,
      workOrdersQuarantined: 0,
      escalationsOutstanding: 0,
    },
    attentionRuns: [],
    recentRuns: [],
    queuedWorkOrders: [],
    quarantinedWorkOrders: [],
    escalations: [],
    specRejections: [],
    ...overrides,
  };
}

function build(
  options: {
    collect?: jest.Mock;
    record?: jest.Mock;
    pushConfigured?: boolean;
    pushAccepted?: boolean;
    webhookConfigured?: boolean;
    webhookAccepted?: boolean;
    targets?: { id: string }[];
  } = {},
) {
  const collect = options.collect ?? jest.fn().mockResolvedValue(state());
  const record =
    options.record ??
    jest
      .fn()
      .mockResolvedValue({ invocationId: 'inv-1', proposalIds: ['prop-1'] });

  const pushSend = jest.fn().mockResolvedValue({
    targetId: 't',
    accepted: options.pushAccepted ?? true,
    gone: false,
  });
  const webhookSend = jest.fn().mockResolvedValue({
    targetId: 'daily-brief',
    accepted: options.webhookAccepted ?? true,
    gone: false,
  });

  const service = new DailyBriefService(
    { collect } as unknown as SnapshotService,
    { record } as unknown as DecisionLogService,
    {
      targets: jest.fn().mockResolvedValue(options.targets ?? [{ id: 't' }]),
    } as unknown as PushSubscriptionsService,
    {
      isConfigured: () => options.pushConfigured ?? true,
      send: pushSend,
    } as unknown as WebPushTransport,
    {
      isConfigured: () => options.webhookConfigured ?? false,
      send: webhookSend,
    } as unknown as FallbackWebhookTransport,
    { get: () => 'https://opifex.example' } as unknown as ConfigService,
  );

  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

  return { service, collect, record, pushSend, webhookSend };
}

describe('DailyBriefService (#93)', () => {
  describe('what it records', () => {
    it('records the brief as a daily-brief proposal', async () => {
      const { service, record } = build();

      await service.send(NOW);

      const [, proposals] = record.mock.calls[0];
      expect(proposals[0].actionClass).toBe('daily-brief');
      expect(proposals[0].outcome).toBe('proposed');
    });

    it('records a quiet day as a proposal too, not as silence', async () => {
      // "Nothing needed you" is the answer, not the absence of one, and #90
      // needs the log to have no gaps.
      const { service, record } = build();

      await service.send(NOW);

      expect(record.mock.calls[0][1][0].summary).toBe(
        'Nothing needed you today.',
      );
    });

    it('names no model, because none was asked', async () => {
      // The ranking is deterministic. Recording a model name would put a
      // claim in the log that nothing backs.
      const { service, record } = build();

      await service.send(NOW);

      expect(record.mock.calls[0][0].model).toBe('none');
    });

    it('stores the composed brief as the invocation text', async () => {
      const { service, record } = build();

      await service.send(NOW);

      expect(record.mock.calls[0][0].snapshotText).toContain(
        'Opifex daily brief',
      );
    });

    it('records whether it was delivered', async () => {
      const { service, record } = build({
        pushAccepted: false,
        webhookConfigured: false,
      });

      await service.send(NOW);

      expect(record.mock.calls[0][1][0].details.delivered).toBe(false);
    });
  });

  describe('delivery', () => {
    it('sends at normal priority, never as an interruption', async () => {
      // A brief delivered at escalation priority would undo the batching it
      // exists to provide.
      const { service, pushSend } = build();

      await service.send(NOW);

      expect(pushSend.mock.calls[0][1].priority).toBe('normal');
    });

    it('carries no escalation id and no receipt', async () => {
      const { service, pushSend } = build();

      await service.send(NOW);

      const payload = pushSend.mock.calls[0][1];
      expect(payload.escalationId).toBeUndefined();
      expect(payload.receiptId).toBeUndefined();
      expect(payload.kind).toBe('daily_brief');
    });

    it('falls back to the webhook when push accepted nothing', async () => {
      const { service, webhookSend } = build({
        pushAccepted: false,
        webhookConfigured: true,
      });

      await service.send(NOW);

      expect(webhookSend).toHaveBeenCalledTimes(1);
    });

    it('does not use the webhook when push already accepted', async () => {
      const { service, webhookSend } = build({
        pushAccepted: true,
        webhookConfigured: true,
      });

      await service.send(NOW);

      expect(webhookSend).not.toHaveBeenCalled();
    });

    it('skips push entirely when it is not configured', async () => {
      const { service, pushSend } = build({ pushConfigured: false });

      await service.send(NOW);

      expect(pushSend).not.toHaveBeenCalled();
    });
  });

  describe('failing safe', () => {
    it('still records the brief when delivery throws', async () => {
      // A brief composed and not sent is in the log where an operator can
      // find it, which is the distinction #58 insists on.
      const { service, record } = build({ pushAccepted: true });
      const failing = build({ pushAccepted: true });
      failing.pushSend.mockRejectedValue(new Error('push is down'));

      await service.send(NOW);
      await failing.service.send(NOW);

      expect(record).toHaveBeenCalled();
      expect(failing.record).toHaveBeenCalled();
      expect(failing.record.mock.calls[0][1][0].details.delivered).toBe(false);
    });

    it('returns null rather than throwing when state cannot be read', async () => {
      const { service, record } = build({
        collect: jest.fn().mockRejectedValue(new Error('database is down')),
      });

      await expect(service.send(NOW)).resolves.toEqual({
        proposalId: null,
        delivered: false,
      });
      expect(record).not.toHaveBeenCalled();
    });

    it('reports delivery even when the log write fails', async () => {
      const { service } = build({
        record: jest.fn().mockRejectedValue(new Error('no database')),
      });

      await expect(service.send(NOW)).resolves.toEqual({
        proposalId: null,
        delivered: true,
      });
    });
  });
});
