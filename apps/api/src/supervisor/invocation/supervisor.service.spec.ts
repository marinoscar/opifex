import { ConfigService } from '@nestjs/config';

import type { DecisionLogService } from '../decision-log/decision-log.service';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { SnapshotInput } from '../snapshot/snapshot.types';
import { SupervisorService } from './supervisor.service';
import {
  UnavailableSupervisorModel,
  type SupervisorModel,
} from './supervisor-model.port';
import type { SupervisorProposer } from './supervisor-proposer.port';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function state(
  overrides: Partial<SnapshotInput['totals']> = {},
): SnapshotInput {
  return {
    generatedAt: NOW,
    windowDays: 1,
    totals: {
      runsRunning: 0,
      runsStalled: 0,
      runsBlocked: 0,
      runsSucceededInWindow: 0,
      runsFailedInWindow: 0,
      workOrdersQueued: 0,
      workOrdersHeld: 0,
      workOrdersQuarantined: 0,
      escalationsOutstanding: 0,
      ...overrides,
    },
    attentionRuns: [],
    recentRuns: [],
    queuedWorkOrders: [],
    quarantinedWorkOrders: [],
    escalations: [],
    specRejections: [],
  };
}

function configDouble(values: Record<string, unknown> = {}) {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function build(
  options: {
    config?: Record<string, unknown>;
    snapshot?: SnapshotInput;
    collectRejects?: Error;
    model?: SupervisorModel;
    proposers?: SupervisorProposer[];
    recordRejects?: Error;
  } = {},
) {
  const collect = options.collectRejects
    ? jest.fn().mockRejectedValue(options.collectRejects)
    : jest.fn().mockResolvedValue(options.snapshot ?? state());
  const record = options.recordRejects
    ? jest.fn().mockRejectedValue(options.recordRejects)
    : jest.fn().mockResolvedValue({ invocationId: 'inv-1', proposalIds: [] });

  const snapshots = {
    collect,
    render: jest.fn(),
  } as unknown as SnapshotService;
  const log = { record } as unknown as DecisionLogService;

  const service = new SupervisorService(
    configDouble({ 'supervisor.enabled': true, ...options.config }),
    snapshots,
    log,
    options.model,
    options.proposers,
  );

  return { service, collect, record };
}

function proposer(
  name: string,
  impl: SupervisorProposer['propose'],
): SupervisorProposer {
  return { name, actionClass: 'run-diagnosis', propose: impl };
}

describe('SupervisorService (#89)', () => {
  describe('when the supervisor is disabled', () => {
    it('records a skipped_disabled row and reads no state', async () => {
      const { service, collect, record } = build({
        config: { 'supervisor.enabled': false },
      });

      const id = await service.invoke(NOW);

      expect(id).toBe('inv-1');
      expect(collect).not.toHaveBeenCalled();
      expect(record.mock.calls[0][0].outcome).toBe('skipped_disabled');
    });

    it('can be disabled entirely by configuration', async () => {
      const { service } = build({ config: { 'supervisor.enabled': false } });
      expect(service.enabled).toBe(false);
    });

    it('treats a missing config value as off, not on', async () => {
      const { service } = build({
        config: { 'supervisor.enabled': undefined },
      });
      expect(service.enabled).toBe(false);
    });
  });

  describe('quota awareness', () => {
    it('stands down while a worker is parked on a rate limit', async () => {
      const { service, record } = build({
        snapshot: state({ runsBlocked: 1 }),
      });

      await service.invoke(NOW);

      const draft = record.mock.calls[0][0];
      expect(draft.outcome).toBe('skipped_quota');
      expect(draft.failureReason).toContain('parked on a rate limit');
    });

    it('never calls a proposer when it stands down', async () => {
      const propose = jest.fn();
      const { service } = build({
        snapshot: state({ runsBlocked: 1 }),
        proposers: [proposer('p', propose)],
      });

      await service.invoke(NOW);

      expect(propose).not.toHaveBeenCalled();
    });

    it('proceeds when nothing is parked', async () => {
      const { service, record } = build({
        snapshot: state({ runsRunning: 2 }),
      });

      await service.invoke(NOW);

      expect(record.mock.calls[0][0].outcome).toBe('completed');
    });

    it('honours a configured live-run ceiling', async () => {
      const { service, record } = build({
        config: { 'supervisor.liveRunCeiling': 2 },
        snapshot: state({ runsRunning: 2 }),
      });

      await service.invoke(NOW);

      expect(record.mock.calls[0][0].outcome).toBe('skipped_quota');
    });
  });

  describe('failing safe', () => {
    it('records a failed row rather than throwing when state cannot be read', async () => {
      const { service, record } = build({
        collectRejects: new Error('database is down'),
      });

      await expect(service.invoke(NOW)).resolves.toBe('inv-1');
      expect(record.mock.calls[0][0].outcome).toBe('failed');
      expect(record.mock.calls[0][0].failureReason).toContain(
        'database is down',
      );
    });

    it('keeps the other proposals when one proposer throws', async () => {
      // The whole point of `partial`: one bad proposer must not cost four
      // good proposals.
      const { service, record } = build({
        proposers: [
          proposer('bad', () => Promise.reject(new Error('boom'))),
          proposer('good', () =>
            Promise.resolve([
              {
                actionClass: 'run-diagnosis' as const,
                outcome: 'proposed' as const,
                summary: 's',
                reasoning: 'r',
              },
            ]),
          ),
        ],
      });

      await service.invoke(NOW);

      expect(record.mock.calls[0][0].outcome).toBe('partial');
      expect(record.mock.calls[0][1]).toHaveLength(1);
    });

    it('returns null rather than throwing when even the log cannot be written', async () => {
      const { service } = build({ recordRejects: new Error('no database') });

      await expect(service.invoke(NOW)).resolves.toBeNull();
    });

    it('does not throw when the model itself is unavailable', async () => {
      // The default binding refuses rather than pretending, and a proposer
      // that calls it fails like any other proposer.
      const { service, record } = build({
        model: new UnavailableSupervisorModel(),
        proposers: [
          proposer('needs-model', async (ctx) => {
            await ctx.model.ask({ snapshot: ctx.snapshot, instruction: 'x' });
            return [];
          }),
        ],
      });

      await expect(service.invoke(NOW)).resolves.toBe('inv-1');
      expect(record.mock.calls[0][0].outcome).toBe('partial');
    });
  });

  describe('what it records', () => {
    it('names the model on every invocation', async () => {
      const model: SupervisorModel = {
        name: 'small-model-1',
        ask: jest.fn(),
      };
      const { service, record } = build({ model });

      await service.invoke(NOW);

      expect(record.mock.calls[0][0].model).toBe('small-model-1');
    });

    it('records "none" when no adapter is bound', async () => {
      const { service, record } = build();
      await service.invoke(NOW);
      expect(record.mock.calls[0][0].model).toBe('none');
    });

    it('stores the snapshot rendered from the state it just read', async () => {
      const { service, record } = build({
        snapshot: state({ runsRunning: 3 }),
      });

      await service.invoke(NOW);

      const draft = record.mock.calls[0][0];
      expect(draft.snapshotText).toContain('# Factory snapshot');
      expect(draft.snapshotText).toContain('3 running');
      expect(draft.snapshotGeneratedAt).toBe(NOW);
      expect(draft.snapshotCharacters).toBe(draft.snapshotText.length);
    });

    it('reads state once, not twice', async () => {
      // Rendering from the state already in hand rather than through
      // `render()` — which would re-issue every query — is also what
      // guarantees the stored text matches what the quota gate judged.
      const { service, collect } = build();

      await service.invoke(NOW);

      expect(collect).toHaveBeenCalledTimes(1);
    });

    it('sums the cost of every model call, whoever made it', async () => {
      // Metered by the service, not trusted to each proposer: a proposer that
      // forgot would make the supervisor look cheaper than it is.
      const model: SupervisorModel = {
        name: 'm',
        ask: jest.fn().mockResolvedValue({
          text: 'ok',
          costUsd: 0.01,
          tokensInput: 100,
          tokensOutput: 20,
        }),
      };
      const ask = async (ctx: { model: SupervisorModel; snapshot: string }) => {
        await ctx.model.ask({ snapshot: ctx.snapshot, instruction: 'x' });
        return [];
      };
      const { service, record } = build({
        model,
        proposers: [proposer('a', ask), proposer('b', ask)],
      });

      await service.invoke(NOW);

      const draft = record.mock.calls[0][0];
      expect(draft.costUsd).toBeCloseTo(0.02);
      expect(draft.tokensInput).toBe(200);
      expect(draft.tokensOutput).toBe(40);
    });

    it('leaves cost null when the adapter reports none', async () => {
      const model: SupervisorModel = {
        name: 'm',
        ask: jest.fn().mockResolvedValue({
          text: 'ok',
          costUsd: null,
          tokensInput: null,
          tokensOutput: null,
        }),
      };
      const { service, record } = build({
        model,
        proposers: [
          proposer('a', async (ctx) => {
            await ctx.model.ask({ snapshot: ctx.snapshot, instruction: 'x' });
            return [];
          }),
        ],
      });

      await service.invoke(NOW);

      // Null, not 0: VISION §6 makes cost reporting a declared capability, so
      // an adapter that does not report must not look free.
      expect(record.mock.calls[0][0].costUsd).toBeNull();
    });

    it('records an invocation with no proposers at all', async () => {
      const { service, record } = build();

      await service.invoke(NOW);

      expect(record.mock.calls[0][0].outcome).toBe('completed');
      expect(record.mock.calls[0][1]).toEqual([]);
    });

    it('hands every proposer the identical snapshot text', async () => {
      const seen: string[] = [];
      const capture = (ctx: { snapshot: string }) => {
        seen.push(ctx.snapshot);
        return Promise.resolve([]);
      };
      const { service, record } = build({
        proposers: [proposer('a', capture), proposer('b', capture)],
      });

      await service.invoke(NOW);

      expect(seen[0]).toBe(seen[1]);
      expect(seen[0]).toBe(record.mock.calls[0][0].snapshotText);
    });
  });

  describe('statelessness', () => {
    it('carries nothing between invocations', async () => {
      // VISION §7's requirement. Two invocations must each read state and each
      // write their own row; anything remembered is the context drift the
      // section describes.
      const { service, collect, record } = build();

      await service.invoke(NOW);
      await service.invoke(new Date(NOW.getTime() + 3_600_000));

      expect(collect).toHaveBeenCalledTimes(2);
      expect(record).toHaveBeenCalledTimes(2);
      expect(record.mock.calls[0][0].startedAt).not.toBe(
        record.mock.calls[1][0].startedAt,
      );
    });
  });
});
