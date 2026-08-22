import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import { DispatchService, OCCUPYING_STATUSES } from './dispatch.service';

function runnerRow(overrides: Record<string, unknown> = {}) {
  return {
    key: 'claude-code-local',
    displayName: 'Claude Code (local)',
    version: '2.1.223',
    enabled: true,
    capability: {
      schemaVersion: '1.0.0',
      invocationModel: 'process',
      executionLocus: 'own_infrastructure',
      streamingFidelity: 'full',
      rateLimitSignal: 'structured',
      stabilityTier: 'stable',
      reportsCost: true,
      resumable: false,
      maxConcurrency: 2,
      branchPatterns: ['factory/*'],
      manifest: {},
    },
    ...overrides,
  };
}

describe('DispatchService', () => {
  let prisma: {
    runner: { findMany: jest.Mock };
    run: { groupBy: jest.Mock; count: jest.Mock };
  };
  let service: DispatchService;

  function build(maxConcurrent: number | null = null) {
    service = new DispatchService(
      prisma as unknown as PrismaService,
      new ConfigService({ dispatch: { maxConcurrent } }),
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  }

  beforeEach(() => {
    prisma = {
      runner: { findMany: jest.fn().mockResolvedValue([runnerRow()]) },
      run: {
        groupBy: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    build();
  });

  describe('what counts as occupying a slot', () => {
    it('counts running, stalled and blocked', () => {
      // `blocked` is the debatable one: a rate-limited run is doing nothing,
      // but it WILL resume on that runner (#56), and freeing the slot now
      // means over-subscribing the moment it does — which breaks the one
      // number the runner told us about itself.
      expect([...OCCUPYING_STATUSES].sort()).toEqual(['blocked', 'running', 'stalled']);
    });

    it('counts none of the terminal statuses', () => {
      for (const done of ['succeeded', 'failed', 'quarantined']) {
        expect(OCCUPYING_STATUSES).not.toContain(done);
      }
    });

    it('asks the database for exactly those', async () => {
      await service.decide([]);

      expect(prisma.run.count).toHaveBeenCalledWith({
        where: { status: { in: OCCUPYING_STATUSES } },
      });
    });
  });

  describe('loading the pool', () => {
    it('counts load with one group-by, not a query per runner', async () => {
      // This runs for every queued work order. A query per runner is how a
      // dispatch path that should be arithmetic becomes an N+1.
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({ key: 'a' }),
        runnerRow({ key: 'b' }),
        runnerRow({ key: 'c' }),
      ]);

      await service.decide([]);

      expect(prisma.run.groupBy).toHaveBeenCalledTimes(1);
    });

    it('attributes live runs to the right runner', async () => {
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({ key: 'busy' }),
        runnerRow({ key: 'idle' }),
      ]);
      prisma.run.groupBy.mockResolvedValue([{ runnerKey: 'busy', _count: { _all: 2 } }]);

      const decision = await service.decide([]);

      expect(decision.runnerKey).toBe('idle');
    });

    it('treats a runner with no live runs as idle rather than unknown', async () => {
      prisma.run.groupBy.mockResolvedValue([]);

      expect((await service.decide([])).candidates[0].headroom).toBe(2);
    });

    it('drops a runner that registered no capability manifest', async () => {
      // There is nothing to match needs against. Defaulting one would route
      // real work on invented facts.
      prisma.runner.findMany.mockResolvedValue([runnerRow({ capability: null })]);

      const decision = await service.decide([]);

      expect(decision.outcome).toBe('queued');
      expect(decision.queueReason).toBe('no-runners-registered');
    });

    it('says which runner it dropped, rather than dropping it quietly', async () => {
      prisma.runner.findMany.mockResolvedValue([runnerRow({ key: 'naked', capability: null })]);
      const warn = jest.spyOn(service['logger'], 'warn');

      await service.decide([]);

      expect(warn.mock.calls.some(([line]) => String(line).includes('naked'))).toBe(true);
    });

    it('loads runners in a stable order', async () => {
      await service.decide([]);

      expect(prisma.runner.findMany.mock.calls[0][0].orderBy).toEqual({ key: 'asc' });
    });
  });

  describe('the global ceiling', () => {
    it('is off when unconfigured', async () => {
      build(null);
      prisma.run.count.mockResolvedValue(9999);

      expect((await service.decide([])).outcome).toBe('dispatch');
    });

    it('queues the work order once the fleet is at it', async () => {
      build(3);
      prisma.run.count.mockResolvedValue(3);

      expect((await service.decide([])).queueReason).toBe('global-concurrency-reached');
    });
  });

  describe('the decision it returns', () => {
    it('dispatches to a capable runner', async () => {
      const decision = await service.decide(['full-streaming', 'cost-reporting']);

      expect(decision).toMatchObject({ outcome: 'dispatch', runnerKey: 'claude-code-local' });
    });

    it('translates the database row into the seam type faithfully', async () => {
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({ capability: { ...runnerRow().capability, streamingFidelity: 'none' } }),
      ]);

      const decision = await service.decide(['full-streaming']);

      expect(decision.candidates[0].unmetNeeds).toEqual(['full-streaming']);
    });

    it('carries the work-order identity into the log line only', async () => {
      // Routing never branches on it — the identity is for the record.
      const log = jest.spyOn(service['logger'], 'log');

      await service.decide([], 'wo_opifex_312_a3f91c2_a1');

      expect(log.mock.calls[0][0]).toContain('wo_opifex_312_a3f91c2_a1');
    });

    it('warns rather than logs when it cannot place the work order', async () => {
      prisma.runner.findMany.mockResolvedValue([]);
      const warn = jest.spyOn(service['logger'], 'warn');

      await service.decide([]);

      expect(warn).toHaveBeenCalled();
    });
  });

  describe('the restated capability enums', () => {
    it.each([
      ['invocationModel', 'RunnerInvocationModel'],
      ['executionLocus', 'RunnerExecutionLocus'],
      ['streamingFidelity', 'RunnerStreamingFidelity'],
      ['rateLimitSignal', 'RunnerSignalQuality'],
      ['stabilityTier', 'RunnerStabilityTier'],
    ])('%s survives the round trip for every Prisma value', async (field, prismaEnum) => {
      // The policy is written against a restated union so it stays pure. That
      // is only safe while the two agree — a value the translation mangled
      // would fail to route with no error anywhere.
      const prisma_ = await import('@prisma/client');
      const values = Object.values(
        (prisma_ as unknown as Record<string, Record<string, string>>)[prismaEnum],
      );

      for (const value of values) {
        prisma.runner.findMany.mockResolvedValue([
          runnerRow({ capability: { ...runnerRow().capability, [field]: value } }),
        ]);

        const decision = await service.decide([]);
        expect(decision.candidates).toHaveLength(1);
      }
    });
  });
});
