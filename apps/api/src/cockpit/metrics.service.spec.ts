import { PrismaService } from '../prisma/prisma.service';
import { METRIC_IDS } from './dto/metrics.dto';
import { MetricsService } from './metrics.service';

/**
 * The honesty contract, as executable rules.
 *
 * Almost every test here is a variation on one question: **does this ever
 * report 0 when it means "no data"?** That is the failure this endpoint exists
 * to avoid — a zero detection latency claims the system noticed every stall
 * instantly, which is the most flattering possible way to be wrong.
 */
describe('MetricsService', () => {
  const MS = 1000;

  function escalation(raisedAt: string, detectLatencyMs: number | null) {
    return { raisedAt: new Date(raisedAt), detectLatencyMs };
  }

  let escalationFindMany: jest.Mock;
  let workOrderFindMany: jest.Mock;
  let service: MetricsService;

  beforeEach(() => {
    escalationFindMany = jest.fn().mockResolvedValue([]);
    workOrderFindMany = jest.fn().mockResolvedValue([]);

    service = new MetricsService({
      escalation: { findMany: escalationFindMany },
      workOrder: { findMany: workOrderFindMany },
    } as unknown as PrismaService);
  });

  describe('the shape', () => {
    it('returns all six metrics, every time', async () => {
      // A missing key would render as a missing tile, and the app's stated job
      // (VISION §10) is to show the six.
      const summary = await service.summary();

      expect(Object.keys(summary.metrics).sort()).toEqual([...METRIC_IDS].sort());
    });

    it('reports when it computed, and over what window', async () => {
      const summary = await service.summary(7);

      const from = new Date(summary.window.from).getTime();
      const to = new Date(summary.window.to).getTime();
      expect(to - from).toBe(7 * 24 * 60 * 60 * 1000);
      expect(summary.generatedAt).toBe(summary.window.to);
    });
  });

  describe('never a zero standing in for no data', () => {
    it('reports null, not 0, for every metric on an empty database', async () => {
      // The state the system is actually in today. If any of these were 0 the
      // dashboard would show a perfect factory that has never run anything.
      const summary = await service.summary();

      for (const id of METRIC_IDS) {
        expect(summary.metrics[id]!.value).toBeNull();
      }
    });

    it('gives an empty trend rather than a row of zeros', async () => {
      // A one-point or empty series draws NOTHING. A row of zeros draws a
      // confident flat line along the floor.
      const summary = await service.summary();

      for (const id of METRIC_IDS) {
        expect(summary.metrics[id]!.trend).toEqual([]);
      }
    });

    it.each(['deadTimePerDay', 'firstPassAcceptance', 'costPerMergedPr', 'quotaBurn'] as const)(
      'leaves %s unmeasured rather than approximating it',
      async (id) => {
        // Each of these could be faked from adjacent data — dead time from
        // currently-stalled runs, quota burn from the GitHub rate limit — and
        // each fake answers a different question than the metric names.
        escalationFindMany.mockResolvedValue([escalation('2026-08-23T01:00:00Z', 5000)]);
        workOrderFindMany.mockResolvedValue([
          { updatedAt: new Date('2026-08-23T01:00:00Z'), _count: { runs: 2 } },
        ]);

        const summary = await service.summary();

        expect(summary.metrics[id]).toEqual({ value: null, trend: [] });
      },
    );
  });

  describe('detection latency', () => {
    it('is reported in seconds, the unit the VISION target is written in', async () => {
      escalationFindMany.mockResolvedValue([escalation('2026-08-23T01:00:00Z', 45 * MS)]);

      const summary = await service.summary();

      expect(summary.metrics.detectionLatency!.value).toBe(45);
    });

    it('uses the p50, so one outage does not define "normal"', async () => {
      escalationFindMany.mockResolvedValue([
        escalation('2026-08-23T01:00:00Z', 2 * MS),
        escalation('2026-08-23T01:00:00Z', 4 * MS),
        escalation('2026-08-23T01:00:00Z', 3600 * MS),
      ]);

      const summary = await service.summary();

      // The p50 of three samples, not the mean (which would be ~20 minutes).
      expect(summary.metrics.detectionLatency!.value).toBe(4);
    });

    it('excludes unmeasurable escalations at the query, not by treating them as 0', async () => {
      // An escalation with no progressStoppedAt has no stop to measure from.
      await service.summary();

      expect(escalationFindMany.mock.calls[0][0].where.detectLatencyMs).toEqual({ not: null });
    });

    it('queries only inside the window', async () => {
      await service.summary(3);

      const where = escalationFindMany.mock.calls[0][0].where;
      const span =
        new Date(where.raisedAt.lte).getTime() - new Date(where.raisedAt.gte).getTime();
      expect(span).toBe(3 * 24 * 60 * 60 * 1000);
    });
  });

  describe('the trend series', () => {
    it('drops quiet days rather than plotting them as zero', async () => {
      // Two days of data inside a seven-day window yields two points, not
      // seven with five zeros. A zero in a latency sparkline is a claim that
      // detection was instantaneous that day.
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      escalationFindMany.mockResolvedValue([
        escalation(new Date(now - 6.5 * day).toISOString(), 10 * MS),
        escalation(new Date(now - 1.5 * day).toISOString(), 20 * MS),
      ]);

      const summary = await service.summary(7);

      expect(summary.metrics.detectionLatency!.trend).toEqual([10, 20]);
    });

    it('is oldest first', async () => {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      escalationFindMany.mockResolvedValue([
        escalation(new Date(now - 5.5 * day).toISOString(), 30 * MS),
        escalation(new Date(now - 0.5 * day).toISOString(), 5 * MS),
      ]);

      const summary = await service.summary(7);

      expect(summary.metrics.detectionLatency!.trend).toEqual([30, 5]);
    });

    it('never contains a zero for a day that had no samples', async () => {
      const now = Date.now();
      escalationFindMany.mockResolvedValue([
        escalation(new Date(now - 1000).toISOString(), 12 * MS),
      ]);

      const summary = await service.summary(30);

      expect(summary.metrics.detectionLatency!.trend).not.toContain(0);
      expect(summary.metrics.detectionLatency!.trend).toHaveLength(1);
    });
  });

  describe('attempts per work order', () => {
    it('averages only over work orders that LANDED', async () => {
      // Counting attempts on work orders still in flight reports a number that
      // falls as they finish, so a busy day would look like an improvement in
      // decomposition quality.
      workOrderFindMany.mockResolvedValue([
        { updatedAt: new Date('2026-08-23T01:00:00Z'), _count: { runs: 1 } },
        { updatedAt: new Date('2026-08-23T02:00:00Z'), _count: { runs: 3 } },
      ]);

      const summary = await service.summary();

      expect(workOrderFindMany.mock.calls[0][0].where.status).toBe('succeeded');
      expect(summary.metrics.attemptsPerWorkOrder!.value).toBe(2);
    });

    it('is null when nothing landed, rather than zero attempts', async () => {
      // "No work order has ever landed" and "work orders land with no attempts"
      // are wildly different claims, and the second one is impossible.
      workOrderFindMany.mockResolvedValue([]);

      const summary = await service.summary();

      expect(summary.metrics.attemptsPerWorkOrder).toEqual({ value: null, trend: [] });
    });
  });
});
