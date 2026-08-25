import { Injectable } from '@nestjs/common';

import {
  deadTimeInWindow,
  describeBasis,
  type DeadIntervalSample,
} from '../dead-time/dead-time';
import { stats } from '../escalations/detection-latency';
import { PrismaService } from '../prisma/prisma.service';
import {
  METRICS_DEFAULT_DAYS,
  NOT_MEASURED,
  type MetricSample,
  type MetricsSummary,
} from './dto/metrics.dto';

/**
 * The six success metrics, and an honest account of which are measurable.
 *
 * ## Three of six, today
 *
 * | Metric | Today | Why |
 * |---|---|---|
 * | `detectionLatency` | **computed** | `Escalation.detectLatencyMs` (#59) |
 * | `deadTimePerDay` | **computed** | `dead_intervals` (#232) |
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
 * `deadTimePerDay` used to be null here, and the refusal it recorded is worth
 * keeping in view now that it computes: the metric could ALWAYS have been
 * approximated as "sum over currently stalled runs of (now − lastEventAt),
 * divided by the window". That produces a plausible number answering a
 * DIFFERENT question — dead time right now, not dead time per day across the
 * window. What changed is not that the approximation became acceptable; it is
 * that #232 built the thing that was missing, so the real quantity exists.
 *
 * `quotaBurn` still refuses the same shape: the GitHub rate limit is measured
 * and could be divided by its reset window, but VISION §11's shared quota is
 * the agent subscription, and labelling one "Quota burn" while measuring the
 * other is the same substitution wearing a better disguise.
 */
@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(days: number = METRICS_DEFAULT_DAYS): Promise<MetricsSummary> {
    const to = new Date();
    const from = new Date(to.getTime() - days * DAY_MS);

    const [
      detectionLatency,
      deadTimePerDay,
      attemptsPerWorkOrder,
      firstPassAcceptance,
      costPerMergedPr,
    ] = await Promise.all([
      this.detectionLatency(from, to, days),
      this.deadTimePerDay(from, to, days),
      this.attemptsPerWorkOrder(from, to, days),
      this.firstPassAcceptance(from, to, days),
      this.costPerMergedPr(from, to, days),
    ]);

    return {
      // When the control plane computed these, not when the client fetched —
      // a panel showing a stale summary should be able to say how stale.
      generatedAt: to.toISOString(),
      window: { from: from.toISOString(), to: to.toISOString() },
      metrics: {
        detectionLatency,
        deadTimePerDay,
        firstPassAcceptance,
        attemptsPerWorkOrder,
        costPerMergedPr,
        // Not measured. See the table at the head of this file; this is a real
        // absence rather than a zero waiting to be filled in.
        quotaBurn: NOT_MEASURED,
      },
    };
  }

  /**
   * Metric 2: hours parked or stalled, per day.
   *
   * VISION §10 states the definition and the cockpit tile already renders it:
   * *"hours parked or stalled"*. Both, which settles the one judgement #232
   * frames and does not answer.
   *
   * ## Parked time counts, and the argument runs the other way from instinct
   *
   * The instinct is that a run `blocked` on a rate limit with a dated resume is
   * the system WORKING — #56 recovers those hours deliberately — so counting
   * them would make a healthy factory on a rate-limited day look broken.
   *
   * It counts anyway:
   *
   *  1. VISION §10 defines the metric as *"hours parked or stalled"*, and this
   *     file's whole ethic is refusing to ship a number under a label that
   *     promises something else.
   *  2. VISION §1's origin story is *"an agent hits a rate limit at 2pm. I find
   *     out at 6pm. Four hours dead"* — parked hours, called dead. §4 repeats
   *     it: an agent *"parked awaiting an answer while its operator sleeps is
   *     exactly the dead time this project exists to eliminate."*
   *  3. If parked time were free the metric would be gameable in the worst
   *     direction: a factory that parked everything and shipped nothing would
   *     score a perfect zero.
   *
   * What #56 actually recovers is not the park — it is the stretch that used to
   * run from the reset time until a human noticed. That shows up here as parked
   * intervals getting SHORTER, so counting them reports the improvement rather
   * than hiding it. `basis` states the split so an operator can always see which
   * half of a bad day was supervision and which was quota.
   *
   * ## Null when nothing was measured, and 0 when nothing was dead
   *
   * These are different claims and the distinction costs one indexed count. An
   * empty ledger over a window in which runs actually EXECUTED means zero dead
   * time, which is the metric's best possible value and must be reportable. An
   * empty ledger over a window with no runs at all means nothing was measured —
   * a freshly deployed control plane, or an idle week — and returns null.
   *
   * Reporting the second as 0 would put "the factory was perfect" on a
   * dashboard on the strength of the factory never having run.
   *
   * ## The trend is FULL-LENGTH, unlike every other metric here
   *
   * `bucket()` below drops empty days because a metric like latency cannot
   * express a gap: an empty day emitting 0 would claim instant detection. Dead
   * time is the opposite — 0 is a real measurement, and a day with no stall and
   * no park genuinely had zero dead hours. Dropping those days would delete
   * exactly the good days from the sparkline and make a recovering factory look
   * like it was always bad.
   */
  private async deadTimePerDay(
    from: Date,
    to: Date,
    days: number,
  ): Promise<MetricSample> {
    // Every interval OVERLAPPING the window, not every interval starting in it.
    // A stall that began before the window is still dead time inside it, and
    // filtering on `startedAt >= from` would silently drop the longest ones —
    // biasing the metric downward exactly where it matters most.
    const rows = await this.prisma.deadInterval.findMany({
      where: {
        startedAt: { lte: to },
        OR: [{ endedAt: null }, { endedAt: { gte: from } }],
      },
      select: { kind: true, startedAt: true, endedAt: true },
    });

    if (rows.length === 0) {
      // Nothing was dead. Whether that is a measurement or an absence depends
      // on whether anything RAN — see the doc comment above.
      const runsInWindow = await this.prisma.run.count({
        where: {
          startedAt: { lte: to },
          OR: [{ endedAt: null }, { endedAt: { gte: from } }],
        },
      });
      if (runsInWindow === 0) return NOT_MEASURED;
    }

    const window = deadTimeInWindow(
      rows as unknown as DeadIntervalSample[],
      from,
      days,
    );

    return {
      value: window.hoursPerDay,
      trend: window.perDayHours,
      basis: describeBasis(window, days),
    };
  }

  /**
   * Metric 3: merged pull requests that needed no second attempt.
   *
   * VISION §10 says this one decides the roadmap — *"if first-pass acceptance
   * is low, adding throughput actively makes life worse."* So the denominator
   * matters as much as the number, and it is stated here as well as in the UI.
   *
   * **Numerator**: merged PRs whose work order was on attempt 1.
   * **Denominator**: merged PRs in the window.
   *
   * A closed-unmerged PR is deliberately in neither. It is not a first-pass
   * acceptance and it is not a failure of one — it is work that was withdrawn,
   * and counting it as a miss would punish the operator for closing something
   * they no longer wanted.
   *
   * Null when nothing merged. Zero would say "everything needed rework", which
   * is a different and false claim.
   */
  private async firstPassAcceptance(
    from: Date,
    to: Date,
    days: number,
  ): Promise<MetricSample> {
    const merged = await this.prisma.run.findMany({
      where: {
        pullRequestState: 'merged',
        pullRequestMergedAt: { gte: from, lte: to },
      },
      select: {
        pullRequestMergedAt: true,
        workOrder: { select: { attempt: true } },
      },
    });

    if (merged.length === 0) return NOT_MEASURED;

    const rate = (rows: typeof merged) =>
      rows.length === 0
        ? null
        : (rows.filter((row) => row.workOrder.attempt === 1).length /
            rows.length) *
          100;

    return {
      value: rate(merged),
      trend: bucket(
        // `raisedAt` is the shared bucketer's date key, not an escalation
        // reference — the merge time is what buckets a merged pull request.
        merged.map((row) => ({ raisedAt: row.pullRequestMergedAt!, row })),
        from,
        days,
        (bucketRows) => rate(bucketRows.map((entry) => entry.row)),
      ),
    };
  }

  /**
   * Metric 5: reported spend in the window, divided by merged pull requests.
   *
   * Reported spend only. An estimate drawn from authorized ceilings would make
   * an economic-viability metric report the budget rather than the bill, and
   * VISION §6 makes cost reporting a declared capability precisely so those two
   * are never confused.
   *
   * Null when nothing merged. Dividing by zero is not "expensive".
   */
  private async costPerMergedPr(
    from: Date,
    to: Date,
    days: number,
  ): Promise<MetricSample> {
    const merged = await this.prisma.run.findMany({
      where: {
        pullRequestState: 'merged',
        pullRequestMergedAt: { gte: from, lte: to },
      },
      select: { pullRequestMergedAt: true, costUsd: true },
    });

    if (merged.length === 0) return NOT_MEASURED;

    const perPr = (rows: typeof merged) => {
      if (rows.length === 0) return null;
      const spend = rows.reduce(
        (total, row) => total + (row.costUsd ? Number(row.costUsd) : 0),
        0,
      );
      return spend / rows.length;
    };

    return {
      value: perPr(merged),
      trend: bucket(
        merged.map((row) => ({ raisedAt: row.pullRequestMergedAt!, row })),
        from,
        days,
        (bucketRows) => perPr(bucketRows.map((entry) => entry.row)),
      ),
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
