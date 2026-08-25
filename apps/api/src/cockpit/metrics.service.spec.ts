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
  let runFindMany: jest.Mock;
  let runCount: jest.Mock;
  let deadIntervalFindMany: jest.Mock;
  let avoidedParkFindMany: jest.Mock;
  let service: MetricsService;

  /** A merged pull request, as metrics 3 and 5 count it (#215). */
  function merged(
    mergedAt: string,
    attempt: number,
    costUsd: number | null = null,
  ) {
    return {
      pullRequestMergedAt: new Date(mergedAt),
      costUsd,
      workOrder: { attempt },
    };
  }

  beforeEach(() => {
    escalationFindMany = jest.fn().mockResolvedValue([]);
    workOrderFindMany = jest.fn().mockResolvedValue([]);
    runFindMany = jest.fn().mockResolvedValue([]);
    // No runs and no intervals: nothing has been measured, which is what the
    // honesty tests below assert produces null rather than zero.
    runCount = jest.fn().mockResolvedValue(0);
    deadIntervalFindMany = jest.fn().mockResolvedValue([]);
    avoidedParkFindMany = jest.fn().mockResolvedValue([]);

    service = new MetricsService({
      escalation: { findMany: escalationFindMany },
      workOrder: { findMany: workOrderFindMany },
      run: { findMany: runFindMany, count: runCount },
      deadInterval: { findMany: deadIntervalFindMany },
      avoidedPark: { findMany: avoidedParkFindMany },
    } as unknown as PrismaService);
  });

  describe('first-pass acceptance and cost per merged PR (#215)', () => {
    // VISION §10 says metric 3 decides the roadmap: "if first-pass acceptance
    // is low, adding throughput actively makes life worse."

    it('is null when nothing merged, never zero', async () => {
      // Zero would say "everything needed rework", which is a different and
      // false claim than "nothing has merged yet".
      const summary = await service.summary(30);

      expect(summary.metrics.firstPassAcceptance.value).toBeNull();
      expect(summary.metrics.costPerMergedPr.value).toBeNull();
    });

    it('counts merges that needed no second attempt', async () => {
      runFindMany.mockResolvedValue([
        merged('2026-08-20T10:00:00Z', 1),
        merged('2026-08-20T11:00:00Z', 1),
        merged('2026-08-20T12:00:00Z', 3),
      ]);

      const summary = await service.summary(30);
      expect(summary.metrics.firstPassAcceptance.value).toBeCloseTo(66.67, 1);
    });

    it('asks only for merged pull requests, so a closed one is in neither half', async () => {
      // A withdrawn pull request is not a first-pass acceptance and not a
      // failure of one; counting it as a miss would punish the operator for
      // closing something they no longer wanted.
      await service.summary(30);

      const [{ where }] = runFindMany.mock.calls[0];
      expect(where.pullRequestState).toBe('merged');
    });

    it('divides reported spend by merged pull requests', async () => {
      runFindMany.mockResolvedValue([
        merged('2026-08-20T10:00:00Z', 1, 4),
        merged('2026-08-20T11:00:00Z', 1, 6),
      ]);

      const summary = await service.summary(30);
      expect(summary.metrics.costPerMergedPr.value).toBe(5);
    });

    it('treats an unreported cost as nothing added, not as a missing PR', async () => {
      // The denominator is merged PRs. A merge whose runner reported no cost
      // still merged, so dropping it would inflate the per-PR figure.
      runFindMany.mockResolvedValue([
        merged('2026-08-20T10:00:00Z', 1, 10),
        merged('2026-08-20T11:00:00Z', 1, null),
      ]);

      const summary = await service.summary(30);
      expect(summary.metrics.costPerMergedPr.value).toBe(5);
    });
  });

  describe('the shape', () => {
    it('returns all six metrics, every time', async () => {
      // A missing key would render as a missing tile, and the app's stated job
      // (VISION §10) is to show the six.
      const summary = await service.summary();

      expect(Object.keys(summary.metrics).sort()).toEqual(
        [...METRIC_IDS].sort(),
      );
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

    it.each(['firstPassAcceptance', 'costPerMergedPr', 'quotaBurn'] as const)(
      'leaves %s unmeasured rather than approximating it',
      async (id) => {
        // Each of these could be faked from adjacent data — dead time from
        // currently-stalled runs, quota burn from the GitHub rate limit — and
        // each fake answers a different question than the metric names.
        escalationFindMany.mockResolvedValue([
          escalation('2026-08-23T01:00:00Z', 5000),
        ]);
        workOrderFindMany.mockResolvedValue([
          { updatedAt: new Date('2026-08-23T01:00:00Z'), _count: { runs: 2 } },
        ]);

        const summary = await service.summary();

        expect(summary.metrics[id]).toEqual({ value: null, trend: [] });
      },
    );
  });

  describe('dead time per day (#232)', () => {
    const HOUR = 60 * 60 * 1000;

    /** An interval placed relative to now, since the window ends at now. */
    function interval(
      startHoursAgo: number,
      endHoursAgo: number | null,
      kind: 'stalled' | 'parked' = 'stalled',
    ) {
      const now = Date.now();
      return {
        kind,
        startedAt: new Date(now - startHoursAgo * HOUR),
        endedAt:
          endHoursAgo === null ? null : new Date(now - endHoursAgo * HOUR),
      };
    }

    it('is null when the ledger is empty AND nothing ran', async () => {
      // A freshly deployed control plane. Zero here would put "the factory was
      // perfect" on a dashboard on the strength of it never having run.
      const summary = await service.summary(7);

      expect(summary.metrics.deadTimePerDay).toEqual({
        value: null,
        trend: [],
      });
    });

    it('is ZERO when runs executed and none was ever dead', async () => {
      // The opposite claim, and a true one: no stall and no park is the
      // metric's best possible value and has to be reportable.
      runCount.mockResolvedValue(4);

      const summary = await service.summary(7);

      expect(summary.metrics.deadTimePerDay!.value).toBe(0);
      expect(summary.metrics.deadTimePerDay!.trend).toHaveLength(7);
    });

    it('averages over the REQUESTED days, not the days that had a stall', async () => {
      // 7 dead hours in a 7-day window is one hour a day, and would be seven
      // times larger if the denominator were "days with data".
      deadIntervalFindMany.mockResolvedValue([interval(10, 3)]);

      const summary = await service.summary(7);

      expect(summary.metrics.deadTimePerDay!.value).toBeCloseTo(1);
    });

    it('counts PARKED time, which is what VISION §10 defines the metric as', async () => {
      deadIntervalFindMany.mockResolvedValue([interval(10, 3, 'parked')]);

      const summary = await service.summary(7);

      expect(summary.metrics.deadTimePerDay!.value).toBeCloseTo(1);
      expect(summary.metrics.deadTimePerDay!.basis).toContain(
        '1.0 h/day parked',
      );
      expect(summary.metrics.deadTimePerDay!.basis).toContain(
        '0.0 h/day stalled',
      );
    });

    /**
     * The failure #232 names directly: a factory that is dead RIGHT NOW must
     * not read as a healthy zero.
     */
    it('counts an OPEN interval, clipped at the end of the window', async () => {
      deadIntervalFindMany.mockResolvedValue([interval(7, null)]);

      const summary = await service.summary(7);

      expect(summary.metrics.deadTimePerDay!.value).toBeCloseTo(1);
      expect(summary.metrics.deadTimePerDay!.basis).toContain(
        '1 of 1 interval(s) in the window are still open',
      );
    });

    it('asks for intervals OVERLAPPING the window, not starting in it', async () => {
      // Filtering on `startedAt >= from` would drop the longest stalls, which
      // biases the metric downward exactly where it matters most.
      await service.summary(7);

      const where = deadIntervalFindMany.mock.calls[0][0].where;
      expect(where.startedAt).not.toHaveProperty('gte');
      expect(where.OR).toEqual([
        { endedAt: null },
        { endedAt: { gte: expect.any(Date) } },
      ]);
    });

    it('states the conventions the number rests on', async () => {
      deadIntervalFindMany.mockResolvedValue([interval(10, 3)]);

      const summary = await service.summary(7);
      const basis = summary.metrics.deadTimePerDay!.basis!;

      expect(basis).toContain('rolling 24h day(s)');
      expect(basis).toContain('split across the days they occupy');
    });

    /**
     * Unlike every other metric here, the dead-time trend keeps its zero days.
     * A day with no stall and no park genuinely had zero dead hours; dropping
     * it would delete exactly the GOOD days from the sparkline.
     */
    it('keeps zero days in the trend rather than dropping them', async () => {
      deadIntervalFindMany.mockResolvedValue([interval(10, 3)]);

      const summary = await service.summary(7);
      const trend = summary.metrics.deadTimePerDay!.trend;

      expect(trend).toHaveLength(7);
      expect(trend.filter((value) => value === 0).length).toBeGreaterThan(0);
      // And the daily values average back to the reported figure.
      const mean = trend.reduce((a, b) => a + b, 0) / trend.length;
      expect(mean).toBeCloseTo(summary.metrics.deadTimePerDay!.value!);
    });
  });

  describe('detection latency', () => {
    it('is reported in seconds, the unit the VISION target is written in', async () => {
      escalationFindMany.mockResolvedValue([
        escalation('2026-08-23T01:00:00Z', 45 * MS),
      ]);

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

      expect(escalationFindMany.mock.calls[0][0].where.detectLatencyMs).toEqual(
        { not: null },
      );
    });

    it('queries only inside the window', async () => {
      await service.summary(3);

      const where = escalationFindMany.mock.calls[0][0].where;
      const span =
        new Date(where.raisedAt.lte).getTime() -
        new Date(where.raisedAt.gte).getTime();
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

      expect(summary.metrics.attemptsPerWorkOrder).toEqual({
        value: null,
        trend: [],
      });
    });
  });

  describe('parks avoided, BESIDE metric 2 (#264)', () => {
    function park(occurredAt: string, exhausted: string[]) {
      return {
        occurredAt: new Date(occurredAt),
        exhaustedRunnerKeys: exhausted,
      };
    }

    it('is not one of the six, so nothing can render it as a metric', async () => {
      // The structural half of "beside metric 2, and visibly not part of it".
      // A member of `metrics` would be walked by `METRIC_IDS`, handed to a
      // tile with a unit formatter, and could be added to `deadTimePerDay`.
      const summary = await service.summary(7);

      expect(METRIC_IDS).not.toContain('avoidedParks');
      expect(Object.keys(summary.metrics)).not.toContain('avoidedParks');
      expect(summary.avoidedParks).toBeDefined();
    });

    it('carries no hours anywhere, because the park did not happen', async () => {
      // The failure this whole issue exists to prevent. There is no interval
      // to measure, so hours could only come from estimating how long the
      // avoided park WOULD have lasted.
      avoidedParkFindMany.mockResolvedValue([
        park('2026-08-23T10:00:00Z', ['spent']),
      ]);
      runCount.mockResolvedValue(3);

      const summary = await service.summary(7);

      // The keys are the structural guarantee: there is no field a renderer
      // could format as a duration, and none to add to `deadTimePerDay`.
      for (const key of Object.keys(summary.avoidedParks)) {
        expect(key).not.toMatch(/hours|duration|ms$|seconds|minutes/i);
      }
      expect(summary.avoidedParks.count).toBe(1);
      // The only mention of hours anywhere is the sentence saying there are
      // none, which is the point rather than a leak.
      expect(summary.avoidedParks.basis).toContain(
        'A count of events, not a duration',
      );
      expect(summary.avoidedParks.basis).toContain('no hours to report');
    });

    it('is NULL when nothing dispatched at all, never zero', async () => {
      // A freshly deployed control plane has not measured zero avoided parks;
      // it has not measured. Same discipline `deadTimePerDay` applies.
      const summary = await service.summary(7);

      expect(summary.avoidedParks.count).toBeNull();
      expect(summary.avoidedParks.basis).toContain('Not measured');
    });

    it('is ZERO when work dispatched and none of it moved', async () => {
      // Today's honest, permanent answer with a single registered runner:
      // there is nowhere for work to move. It must not read as an absence.
      runCount.mockResolvedValue(12);

      const summary = await service.summary(7);

      expect(summary.avoidedParks.count).toBe(0);
      expect(summary.avoidedParks.basis).toContain('12 dispatch(es)');
      expect(summary.avoidedParks.basis).toContain('measurement, not a gap');
    });

    it('distinguishes the two states on the same empty ledger', async () => {
      // The distinction is the acceptance criterion, so it is asserted as a
      // difference rather than as two independent readings. Both states are
      // reachable today, which is what makes it real rather than decorative.
      const notMeasured = await service.summary(7);
      runCount.mockResolvedValue(1);
      const measuredZero = await service.summary(7);

      expect(notMeasured.avoidedParks.count).toBeNull();
      expect(measuredZero.avoidedParks.count).toBe(0);
    });

    it('counts the events in the window', async () => {
      avoidedParkFindMany.mockResolvedValue([
        park('2026-08-23T12:00:00Z', ['spent']),
        park('2026-08-23T11:00:00Z', ['spent']),
        park('2026-08-23T10:00:00Z', ['spent']),
      ]);
      runCount.mockResolvedValue(9);

      const summary = await service.summary(7);

      expect(summary.avoidedParks.count).toBe(3);
      expect(summary.avoidedParks.mostRecentAt).toBe(
        '2026-08-23T12:00:00.000Z',
      );
    });

    it('asks only for events inside the window', async () => {
      await service.summary(7);

      const [{ where }] = avoidedParkFindMany.mock.calls[0];
      expect(where.occurredAt.gte).toBeInstanceOf(Date);
      expect(where.occurredAt.lte).toBeInstanceOf(Date);
    });

    it('names which runner the work moved off, so the count is actionable', async () => {
      // A bare integer is not something an operator can do anything with.
      avoidedParkFindMany.mockResolvedValue([
        park('2026-08-23T12:00:00Z', ['claude-code-local']),
        park('2026-08-23T11:00:00Z', ['claude-code-local']),
        park('2026-08-23T10:00:00Z', ['other']),
      ]);
      runCount.mockResolvedValue(9);

      const summary = await service.summary(7);

      expect(summary.avoidedParks.byExhaustedRunner).toEqual([
        { runnerKey: 'claude-code-local', count: 2 },
        { runnerKey: 'other', count: 1 },
      ]);
      expect(summary.avoidedParks.basis).toContain(
        'work moved off claude-code-local 2 time(s)',
      );
    });

    it('counts one event when two runners were spent at once', async () => {
      // The attribution may exceed the count, and that is deliberate: a
      // dispatch that moved off two spent runners is ONE avoided park.
      avoidedParkFindMany.mockResolvedValue([
        park('2026-08-23T12:00:00Z', ['a', 'b']),
      ]);
      runCount.mockResolvedValue(1);

      const summary = await service.summary(7);

      expect(summary.avoidedParks.count).toBe(1);
      expect(summary.avoidedParks.byExhaustedRunner).toHaveLength(2);
    });
  });
});
