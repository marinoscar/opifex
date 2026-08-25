import { Logger } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import type { RunnerQuotaObservation } from '../runners/runner.types';
import { QuotaService } from './quota.service';

/**
 * Prisma is a double: what is under test is which windows get written and what
 * the reading claims, not whether Postgres can store a row.
 */
describe('QuotaService', () => {
  const NOW = new Date('2026-08-25T12:00:00.000Z');
  const RESETS_AT = new Date('2026-08-25T15:00:00.000Z');

  let upsert: jest.Mock;
  let findUnique: jest.Mock;
  let findMany: jest.Mock;
  let aggregate: jest.Mock;
  let runCount: jest.Mock;
  let service: QuotaService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    upsert = jest.fn().mockResolvedValue({});
    findUnique = jest.fn().mockResolvedValue(null);
    findMany = jest.fn().mockResolvedValue([]);
    aggregate = jest.fn().mockResolvedValue({
      _sum: { costUsd: null, tokensInput: null, tokensOutput: null },
      _count: { costUsd: 0 },
    });
    runCount = jest.fn().mockResolvedValue(0);

    service = new QuotaService({
      quotaWindow: { upsert, findUnique, findMany },
      runEvent: { aggregate },
      run: { count: runCount },
    } as unknown as PrismaService);
  });

  afterEach(() => jest.restoreAllMocks());

  function sighting(
    overrides: Partial<RunnerQuotaObservation> = {},
  ): RunnerQuotaObservation {
    return {
      runnerKey: 'claude-code-local',
      kind: 'five_hour',
      resetsAt: RESETS_AT,
      pressure: 'allowed',
      observedAt: new Date('2026-08-25T11:00:00.000Z'),
      ...overrides,
    };
  }

  describe('record', () => {
    it('writes one row per window however many lines carried it', async () => {
      const written = await service.record([
        sighting(),
        sighting({ observedAt: new Date('2026-08-25T11:01:00.000Z') }),
      ]);

      expect(written).toBe(1);
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert.mock.calls[0][0].create.observations).toBe(2);
    });

    it('does nothing at all for an empty batch', async () => {
      // The common case by far: most polls see no rate-limit line.
      expect(await service.record([])).toBe(0);
      expect(upsert).not.toHaveBeenCalled();
    });

    it('keeps a peak already stored rather than letting a calm batch erase it', async () => {
      // The peak is the worst reading EVER seen for this window. A batch of
      // `allowed` sightings after an exhaustion an hour ago must not overwrite
      // the fact that the wall was hit.
      findUnique.mockResolvedValue({ peakPressure: 'exhausted' });

      await service.record([sighting({ pressure: 'allowed' })]);

      expect(upsert.mock.calls[0][0].update.peakPressure).toBe('exhausted');
      expect(upsert.mock.calls[0][0].update.pressure).toBe('allowed');
    });

    it('loses one bad window without losing the others, and never throws', async () => {
      // This runs inside the poller's tick. A quota write that killed a tick
      // would stop events reaching the control plane for the whole fleet —
      // trading the signal this adds for the one everything depends on.
      upsert
        .mockRejectedValueOnce(new Error('no runners row yet'))
        .mockResolvedValueOnce({});

      const written = await service.record([
        sighting({ kind: 'five_hour' }),
        sighting({ kind: 'weekly' }),
      ]);

      expect(written).toBe(1);
    });
  });

  describe('readings', () => {
    const window = {
      runnerKey: 'claude-code-local',
      kind: 'five_hour',
      resetsAt: RESETS_AT,
      pressure: 'allowed',
      peakPressure: 'warning',
      firstObservedAt: new Date('2026-08-25T09:00:00.000Z'),
      lastObservedAt: new Date('2026-08-25T11:55:00.000Z'),
      observations: 12,
    };

    it('reports no runner at all when nothing has been observed', async () => {
      // #231's last acceptance criterion: a fleet whose runners report no
      // quota still works, with the metric null throughout. An unobserved
      // runner is ABSENT, not present with zeroes — a row of zeroes is a claim
      // nobody made.
      expect(await service.readings(NOW)).toEqual([]);
    });

    it('never computes a burn fraction, and says so with a field', async () => {
      // The whole argument, pinned. No capacity is published to divide by
      // (#102), and the numerator is Opifex's share of a subscription VISION
      // §11 shares with the operator's interactive use. Carried as an explicit
      // null rather than omitted: an absent key reads as an oversight.
      findMany.mockResolvedValue([window]);

      const [reading] = await service.readings(NOW);

      expect(reading.burnFraction).toBeNull();
      expect(Object.keys(reading)).toContain('burnFraction');
      expect(reading.basis).toContain('not the window');
    });

    it('sums consumption over the vendor window, clipped at now', async () => {
      // A window runs into the future. Summing to its reset instant would
      // present a partial window as a whole one.
      findMany.mockResolvedValue([window]);

      await service.readings(NOW);

      expect(aggregate.mock.calls[0][0].where.occurredAt).toEqual({
        // 15:00 reset minus the five hours the label names.
        gte: new Date('2026-08-25T10:00:00.000Z'),
        lte: NOW,
      });
      expect(aggregate.mock.calls[0][0].where.run).toEqual({
        runnerKey: 'claude-code-local',
      });
    });

    it('reports an unreported cost as null, never as zero', async () => {
      // The rule `Run.costUsd` follows: a runner that cannot report cost must
      // not look like one that spent nothing.
      findMany.mockResolvedValue([window]);
      runCount.mockResolvedValue(4);

      const [reading] = await service.readings(NOW);

      expect(reading.opifexConsumption.reportedUsd).toBeNull();
      expect(reading.opifexConsumption.runs).toBe(4);
    });

    it('reports a measured cost, and names whose consumption it is', async () => {
      findMany.mockResolvedValue([window]);
      aggregate.mockResolvedValue({
        _sum: {
          costUsd: { toNumber: () => 4.25 },
          tokensInput: 1000,
          tokensOutput: 250,
        },
        _count: { costUsd: 3 },
      });

      const [reading] = await service.readings(NOW);

      expect(reading.opifexConsumption.reportedUsd).toBe(4.25);
      expect(reading.opifexConsumption.tokensInput).toBe(1000);
      // Named for whose it is at every layer it crosses, on the principle
      // `SpendTally.estimatedUsd` follows.
      expect(reading.basis).toContain("Opifex's own runs");
    });

    it('keeps the peak beside the current reading', async () => {
      findMany.mockResolvedValue([window]);

      const [reading] = await service.readings(NOW);

      expect(reading.pressure).toBe('allowed');
      expect(reading.peakPressure).toBe('warning');
    });

    it('takes the newest live window when a runner has several', async () => {
      // Ordered newest-first by the query; the first one seen for a key wins.
      findMany.mockResolvedValue([
        { ...window, resetsAt: new Date('2026-08-25T20:00:00.000Z') },
        window,
      ]);

      const [reading] = await service.readings(NOW);

      expect(reading.resetsAt).toBe('2026-08-25T20:00:00.000Z');
      expect(await service.readings(NOW)).toHaveLength(1);
    });

    it('flags a partial window so the sum is read as a floor', async () => {
      // The label names no length this system knows, so the span starts at the
      // first sighting — anything that ran before it is inside the window and
      // outside the sum.
      findMany.mockResolvedValue([{ ...window, kind: 'lunar_cycle' }]);

      const [reading] = await service.readings(NOW);

      expect(reading.partialWindow).toBe(true);
      expect(reading.startedAtBasis).toBe('first-observation');
      expect(reading.basis).toContain('FLOOR');
    });

    it('asks only for windows that have not rolled yet', async () => {
      await service.readings(NOW);

      expect(findMany.mock.calls[0][0].where).toEqual({
        resetsAt: { gt: NOW },
      });
    });
  });
});
