import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { stats } from '../escalations/detection-latency';
import {
  METRICS_DEFAULT_DAYS,
  NOT_MEASURED,
  type MetricSample,
  type MetricsSummary,
} from './dto/metrics.dto';

/**
 * The six success metrics, and an honest account of which are measurable.
 *
 * ## Two of six, today
 *
 * | Metric | Today | Why |
 * |---|---|---|
 * | `detectionLatency` | **computed** | `Escalation.detectLatencyMs` (#59) |
 * | `deadTimePerDay` | null | nothing records how long a run SPENT stalled |
 * | `firstPassAcceptance` | null | merge state is not tracked anywhere |
 * | `attemptsPerWorkOrder` | **computed** | runs per work order that landed |
 * | `costPerMergedPr` | null | merge state is not tracked anywhere |
 * | `quotaBurn` | null | consumption vs window capacity is not recorded |
 *
 * Each null is a real absence, checked rather than assumed, and each is
 * reachable by building the thing named — not by computing something adjacent
 * and calling it the metric.
 *
 * ## The temptation this deliberately refuses
 *
 * `deadTimePerDay` could be approximated as "sum over currently stalled runs
 * of (now − lastEventAt), divided by the window". That produces a plausible
 * number that answers a DIFFERENT question — dead time right now, not dead
 * time per day across the window — and a dashboard whose numbers answer
 * questions nobody asked is worse than one that says it does not know.
 *
 * Same for `quotaBurn`: the GitHub rate limit is measured and could be divided
 * by its reset window, but VISION §11's shared quota is the agent
 * subscription, and labelling one "Quota burn" while measuring the other is
 * the same substitution wearing a better disguise.
 */
@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(days: number = METRICS_DEFAULT_DAYS): Promise<MetricsSummary> {
    const to = new Date();
    const from = new Date(to.getTime() - days * DAY_MS);

    const [detectionLatency, attemptsPerWorkOrder] = await Promise.all([
      this.detectionLatency(from, to, days),
      this.attemptsPerWorkOrder(from, to, days),
    ]);

    return {
      // When the control plane computed these, not when the client fetched —
      // a panel showing a stale summary should be able to say how stale.
      generatedAt: to.toISOString(),
      window: { from: from.toISOString(), to: to.toISOString() },
      metrics: {
        detectionLatency,
        // Not measured. See the table at the head of this file; each of these
        // is a real absence rather than a zero waiting to be filled in.
        deadTimePerDay: NOT_MEASURED,
        firstPassAcceptance: NOT_MEASURED,
        attemptsPerWorkOrder,
        costPerMergedPr: NOT_MEASURED,
        quotaBurn: NOT_MEASURED,
      },
    };
  }

  // -------------------------------------------------------------------------

  /**
   * Stop → notified, in SECONDS.
   *
   * VISION §10's only stated target is "seconds", so the value is reported in
   * the unit the target is written in — the cockpit's formatter expects
   * seconds and renders `45s` or `5m 30s`.
   *
   * The p50 rather than the mean: one pathological detection during a GitHub
   * outage would drag a mean into meaninglessness, and the question the tile
   * answers is "what is detection normally like".
   */
  private async detectionLatency(
    from: Date,
    to: Date,
    days: number,
  ): Promise<MetricSample> {
    const rows = await this.prisma.escalation.findMany({
      where: {
        raisedAt: { gte: from, lte: to },
        // Unmeasurable escalations are EXCLUDED, not counted as zero. An
        // escalation with no `progressStoppedAt` has no stop to measure from.
        detectLatencyMs: { not: null },
      },
      select: { raisedAt: true, detectLatencyMs: true },
      orderBy: { raisedAt: 'asc' },
    });

    const samples = rows
      .map((row) => row.detectLatencyMs)
      .filter((value): value is number => value !== null);

    // `stats` already returns nulls rather than zeros for an empty sample, and
    // reusing it keeps this metric and #59's latency endpoint reporting the
    // same p50 for the same window rather than two nearly-equal numbers.
    const p50 = stats(samples).p50Ms;

    return {
      value: p50 === null ? null : p50 / 1000,
      trend: bucket(rows, from, days, (bucketRows) => {
        const bucketP50 = stats(
          bucketRows
            .map((row) => row.detectLatencyMs)
            .filter((value): value is number => value !== null),
        ).p50Ms;
        return bucketP50 === null ? null : bucketP50 / 1000;
      }),
    };
  }

  /**
   * Runs before a work order LANDS.
   *
   * Averaged over work orders that reached `succeeded` in the window, and over
   * nothing else: counting attempts on work orders still in flight would
   * report a number that falls as they finish, so a busy day would look like
   * an improvement in decomposition quality.
   *
   * Null when nothing landed — which is the honest state today, since no run
   * has ever completed.
   */
  private async attemptsPerWorkOrder(
    from: Date,
    to: Date,
    days: number,
  ): Promise<MetricSample> {
    const landed = await this.prisma.workOrder.findMany({
      where: { status: 'succeeded', updatedAt: { gte: from, lte: to } },
      select: { updatedAt: true, _count: { select: { runs: true } } },
      orderBy: { updatedAt: 'asc' },
    });

    if (landed.length === 0) return NOT_MEASURED;

    const mean = (rows: typeof landed) =>
      rows.reduce((total, row) => total + row._count.runs, 0) / rows.length;

    return {
      value: mean(landed),
      trend: bucket(
        landed.map((row) => ({ ...row, raisedAt: row.updatedAt })),
        from,
        days,
        (bucketRows) => (bucketRows.length === 0 ? null : mean(bucketRows)),
      ),
    };
  }
}

// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One value per day, oldest first — with EMPTY DAYS DROPPED.
 *
 * The trend is `number[]` and cannot express a gap, so a quiet day has two
 * possible representations and only one of them is true. Emitting `0` would
 * draw a latency sparkline through the floor and claim the system detected
 * everything instantly that day; omitting the day says only that there is
 * nothing to plot for it.
 *
 * That makes the series shorter than the window rather than fixed-length,
 * which `Sparkline` handles: it draws nothing for zero or one point rather
 * than a flat line implying a stability nobody measured.
 */
function bucket<T extends { raisedAt: Date }>(
  rows: T[],
  from: Date,
  days: number,
  reduce: (rows: T[]) => number | null,
): number[] {
  const series: number[] = [];

  for (let day = 0; day < days; day += 1) {
    const start = from.getTime() + day * DAY_MS;
    const end = start + DAY_MS;
    const inBucket = rows.filter(
      (row) => row.raisedAt.getTime() >= start && row.raisedAt.getTime() < end,
    );

    const value = reduce(inBucket);
    if (value !== null) series.push(value);
  }

  return series;
}
