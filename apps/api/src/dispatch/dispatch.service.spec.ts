import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import {
  DispatchService,
  OCCUPYING_STATUSES,
  QUOTA_BLOCK_REASONS,
} from './dispatch.service';

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

/**
 * A run sitting `blocked`, as `loadQuotaBlocks` selects it.
 *
 * This shape IS the quota signal: there is no meter to mock, because there is
 * no meter (#231 is unbuilt). What the control plane genuinely has is a dated,
 * first-hand block reported by the runner.
 */
function blockedRun(
  overrides: {
    runnerKey?: string;
    resumesAt?: Date | null;
    blockedReason?: string | null;
    blockedUntil?: Date | null;
  } = {},
) {
  const {
    runnerKey = 'claude-code-local',
    resumesAt = null,
    blockedReason = 'rate-limit',
    blockedUntil = new Date(Date.now() + 3 * 60 * 60_000),
  } = overrides;

  return { runnerKey, resumesAt, events: [{ blockedReason, blockedUntil }] };
}

describe('DispatchService', () => {
  let prisma: {
    runner: { findMany: jest.Mock };
    run: { groupBy: jest.Mock; count: jest.Mock; findMany: jest.Mock };
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
        findMany: jest.fn().mockResolvedValue([]),
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
      expect([...OCCUPYING_STATUSES].sort()).toEqual([
        'blocked',
        'running',
        'stalled',
      ]);
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
      prisma.run.groupBy.mockResolvedValue([
        { runnerKey: 'busy', _count: { _all: 2 } },
      ]);

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
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({ capability: null }),
      ]);

      const decision = await service.decide([]);

      expect(decision.outcome).toBe('queued');
      expect(decision.queueReason).toBe('no-runners-registered');
    });

    it('says which runner it dropped, rather than dropping it quietly', async () => {
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({ key: 'naked', capability: null }),
      ]);
      const warn = jest.spyOn(service['logger'], 'warn');

      await service.decide([]);

      expect(
        warn.mock.calls.some(([line]) => String(line).includes('naked')),
      ).toBe(true);
    });

    it('loads runners in a stable order', async () => {
      await service.decide([]);

      expect(prisma.runner.findMany.mock.calls[0][0].orderBy).toEqual({
        key: 'asc',
      });
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

      expect((await service.decide([])).queueReason).toBe(
        'global-concurrency-reached',
      );
    });
  });

  describe('the decision it returns', () => {
    it('dispatches to a capable runner', async () => {
      const decision = await service.decide([
        'full-streaming',
        'cost-reporting',
      ]);

      expect(decision).toMatchObject({
        outcome: 'dispatch',
        runnerKey: 'claude-code-local',
      });
    });

    it('translates the database row into the seam type faithfully', async () => {
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({
          capability: { ...runnerRow().capability, streamingFidelity: 'none' },
        }),
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
    ])(
      '%s survives the round trip for every Prisma value',
      async (field, prismaEnum) => {
        // The policy is written against a restated union so it stays pure. That
        // is only safe while the two agree — a value the translation mangled
        // would fail to route with no error anywhere.
        const prisma_ = await import('@prisma/client');
        const values = Object.values(
          (prisma_ as unknown as Record<string, Record<string, string>>)[
            prismaEnum
          ],
        );

        for (const value of values) {
          prisma.runner.findMany.mockResolvedValue([
            runnerRow({
              capability: { ...runnerRow().capability, [field]: value },
            }),
          ]);

          const decision = await service.decide([]);
          expect(decision.candidates).toHaveLength(1);
        }
      },
    );
  });
  describe('the quota position it derives (#105)', () => {
    it('reads it from blocked runs, because there is no quota meter to read', async () => {
      // #231 (a real consumption model) is open and unbuilt. What IS recorded
      // is an observed position: this runner has a run blocked on a rate limit
      // with a reset time in the future.
      prisma.run.findMany.mockResolvedValue([blockedRun()]);

      const decision = await service.decide([]);

      expect(decision.outcome).toBe('queued');
      expect(decision.queueReason).toBe('capable-runners-quota-exhausted');
    });

    it('resolves the time comparison here, where the clock lives', async () => {
      // The policy is pure and has no now. A reset that has already passed is
      // no longer a quota fact, and it is THIS class that decides that.
      prisma.run.findMany.mockResolvedValue([
        blockedRun({ blockedUntil: new Date(Date.now() - 60_000) }),
      ]);

      expect((await service.decide([])).outcome).toBe('dispatch');
    });

    it('waits out the jitter too, taking the later of the two dates', async () => {
      // `blockedUntil` is when the vendor said the window rolls; `resumesAt`
      // is that plus #56's jitter. Treating the runner as refilled while the
      // run that found the block is still waiting buys a second block.
      prisma.run.findMany.mockResolvedValue([
        blockedRun({
          blockedUntil: new Date(Date.now() - 60_000),
          resumesAt: new Date(Date.now() + 60_000),
        }),
      ]);

      expect((await service.decide([])).outcome).toBe('queued');
    });

    it('ignores a block that says nothing about quota', async () => {
      // `awaiting-approval` is a fact about one run, not about the
      // subscription. Taking a runner out of service for it would be inventing
      // a quota fact nobody observed.
      prisma.run.findMany.mockResolvedValue([
        blockedRun({ blockedReason: 'awaiting-approval' }),
      ]);

      expect((await service.decide([])).outcome).toBe('dispatch');
    });

    it('treats an unclassifiable block as unknown rather than as exhausted', async () => {
      // VISION §6 cuts this way too: `unknown` is not zero.
      prisma.run.findMany.mockResolvedValue([
        blockedRun({ blockedReason: 'unknown' }),
      ]);

      expect((await service.decide([])).outcome).toBe('dispatch');
    });

    it('leaves an UNDATED quota block to the watchdog rather than parking routing on it', async () => {
      // Nothing can say when it lifts, so marking the runner exhausted would
      // keep it out of routing until a human intervened - turning one undated
      // block into an open-ended refusal to use the fleet's only runner. #56
      // already escalates this case, which is what it needs.
      prisma.run.findMany.mockResolvedValue([
        blockedRun({ blockedUntil: null, resumesAt: null }),
      ]);

      expect((await service.decide([])).outcome).toBe('dispatch');
    });

    it('attributes exhaustion to the runner that reported it, not the fleet', async () => {
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({ key: 'spent' }),
        runnerRow({ key: 'fresh' }),
      ]);
      prisma.run.findMany.mockResolvedValue([
        blockedRun({ runnerKey: 'spent' }),
      ]);

      expect((await service.decide([])).runnerKey).toBe('fresh');
    });

    it('records and logs the avoided park, which is the countable event', async () => {
      // The before-and-after measure #105 is judged by. The arithmetic that
      // turns these into dead time per day is #232's and is not built.
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({ key: 'spent' }),
        runnerRow({ key: 'fresh' }),
      ]);
      prisma.run.findMany.mockResolvedValue([
        blockedRun({ runnerKey: 'spent' }),
      ]);
      const log = jest.spyOn(service['logger'], 'log');

      const decision = await service.decide([], 'wo_opifex_105_a3f91c2_a1');

      expect(decision.avoidedQuotaPark).toBe(true);
      expect(
        log.mock.calls.some(([line]) =>
          String(line).includes('avoided a park'),
        ),
      ).toBe(true);
    });

    it('claims nothing was moved when the whole fleet is spent', async () => {
      // Today's real fleet: one runner (#102/#103 are blocked on the vendor
      // CLI refusing `--cloud` with `--print`). It parks, exactly as before.
      prisma.run.findMany.mockResolvedValue([blockedRun()]);

      const decision = await service.decide([]);

      expect(decision.avoidedQuotaPark).toBe(false);
    });

    it('asks for the whole fleet once, not once per runner', async () => {
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({ key: 'a' }),
        runnerRow({ key: 'b' }),
        runnerRow({ key: 'c' }),
      ]);

      await service.decide([]);

      expect(prisma.run.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.run.findMany.mock.calls[0][0]).toMatchObject({
        where: { status: 'blocked' },
      });
    });

    it('reads only the runner-reported block reasons as quota facts', async () => {
      // Spelled against the wire vocabulary so a rename fails to compile
      // rather than silently matching nothing.
      expect([...QUOTA_BLOCK_REASONS].sort()).toEqual([
        'quota-exhausted',
        'rate-limit',
      ]);
    });
  });
});
