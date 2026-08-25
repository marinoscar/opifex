import { Injectable, Logger } from '@nestjs/common';

import { toNumberOrNull, type DecimalLike } from '../common/decimal';
import type { RunnerQuotaPosition } from '../dispatch/dispatch-policy';
import { PrismaService } from '../prisma/prisma.service';
import type { RunnerQuotaObservation } from '../runners/runner.types';
import {
  collapseObservations,
  meterQuotaPosition,
  windowSpan,
  worsePressure,
  type WindowSpan,
  type WindowStartBasis,
} from './quota-window';
import type { QuotaPressure } from '../runners/runner.types';

/**
 * What the agent subscription's windows look like, and what Opifex put through
 * them (#231).
 *
 * ## The one thing this is not
 *
 * It is not a burn meter. `quota-window.ts` carries the argument in full; the
 * short version is that burn needs a capacity to divide by, no vendor publishes
 * one (#102), and the numerator would be incomplete even if one existed —
 * VISION §11's subscription is shared with the operator's own interactive use,
 * which burns the same window and leaves no row behind. `quotaBurn` therefore
 * stays `NOT_MEASURED` in `cockpit/metrics.service.ts`, and nothing here
 * computes a fraction for anybody to mistake for one.
 *
 * ## Recording and reading are separate, and the recorded half is thin
 *
 * `record` writes windows: the vendor's reset instant, its label, and an
 * ordinal pressure reading. It writes no consumption at all, because
 * consumption already lives on `run_events.cost_usd` and `tokens_*` — a copy
 * here would be the second source of truth that `dispatch/dispatch-policy.ts`
 * warns about for the position signal, and the two would disagree the first
 * time an event arrived late.
 *
 * `readings` sums those events between a window's start and its reset. That
 * makes the total as right as the events are, and lets a late-ingested event
 * correct a window that has already been read rather than being lost. It
 * reports EVERY live window per runner, not the newest one — see the method
 * for why the newest was the least useful of the choices available (#301).
 *
 * ## Unknown is never zero, at every level
 *
 * A runner nobody has observed has no window and appears in no reading — not a
 * reading of zero. A window nothing ran in has `reportedUsd: null` rather than
 * `0`. Both follow the rule `Run.costUsd` follows, for the reason
 * `schemas/runner-capability.schema.json` gives: a runner that cannot report
 * must not look like one that spent nothing.
 */
@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record window sightings a runner reported on its last poll.
   *
   * Idempotent by construction: the same window seen fifty times is one row
   * with an observation count, keyed on `(runnerKey, kind, resetsAt)`. That is
   * what lets `poll` stay dumb — an adapter reports every sighting and never
   * has to remember which ones it already sent.
   *
   * Never throws. This runs inside the poller's tick, and a quota write that
   * killed a tick would stop events reaching the control plane for the whole
   * fleet — trading the signal this exists to add for the signal everything
   * else depends on.
   */
  async record(
    observations: readonly RunnerQuotaObservation[],
  ): Promise<number> {
    if (observations.length === 0) return 0;

    let written = 0;
    for (const window of collapseObservations(observations)) {
      try {
        // Read before write, so the stored peak participates: the peak is the
        // worst reading EVER seen for this window, and this batch may be a
        // calmer one after an exhaustion an hour ago. A race between two
        // pollers could lose a peak here; there is one poller (#147), and a
        // lost peak would cost a historical annotation rather than a decision.
        const storedPeak = await this.storedPeak(
          window.runnerKey,
          window.kind,
          window.resetsAt,
        );

        await this.prisma.quotaWindow.upsert({
          where: {
            runnerKey_kind_resetsAt: {
              runnerKey: window.runnerKey,
              kind: window.kind,
              resetsAt: window.resetsAt,
            },
          },
          create: {
            runnerKey: window.runnerKey,
            kind: window.kind,
            resetsAt: window.resetsAt,
            pressure: window.pressure,
            peakPressure: window.peakPressure,
            firstObservedAt: window.firstObservedAt,
            lastObservedAt: window.lastObservedAt,
            observations: window.observations,
          },
          update: {
            pressure: window.pressure,
            peakPressure: worsePressure(storedPeak, window.peakPressure),
            lastObservedAt: window.lastObservedAt,
            observations: { increment: window.observations },
          },
        });
        written += 1;
      } catch (error) {
        // One bad window must not lose the others, and none of them may take
        // the tick down. The likeliest cause is a runner key with no `runners`
        // row yet — registration converges on its own tick (#162), so the next
        // sighting of the same window will land.
        this.logger.warn(
          `Could not record a ${window.kind} quota window for ${window.runnerKey}: ` +
            asMessage(error),
        );
      }
    }

    return written;
  }

  /**
   * Every live window per runner, plus the one position that binds (#301).
   *
   * ## All of them, because one of them was the wrong one
   *
   * This used to return the NEWEST live window per runner and drop the rest.
   * `quota_windows` is unique on `(runnerKey, kind, resetsAt)`, so a runner
   * routinely holds several live rows — a `five_hour` and a `weekly`, and two
   * of a kind whenever the vendor's reported reset drifts. A weekly window
   * almost always resets later than a five-hour one, so the row that survived
   * the sort was usually the weekly one, and **an exhausted five-hour window
   * was hidden behind a healthy weekly one**. The panel said the runner was
   * fine; the runner could not take work for another four hours.
   *
   * That is worse than missing data, because there was nothing on the screen
   * to prompt a second look. So every live window is returned, soonest reset
   * first. An operator looking at quota wants both numbers — "fine for the
   * week, out for the next four hours" is one fact, and showing one window
   * means choosing which half of it to hide.
   *
   * ## The binding answer comes from routing's own function, not a copy
   *
   * `position` is {@link meterQuotaPosition}, the same function
   * `DispatchService` resolves against. It is not reimplemented here and must
   * not be: two implementations of "which window binds" is precisely how the
   * masking survived — routing read the rows itself specifically to route
   * around this method, and only the path nobody re-derived stayed wrong. One
   * function means the cockpit's answer to "can this runner work now" and the
   * fleet's answer are the same answer.
   *
   * A runner with no live window is ABSENT from the result rather than present
   * with zeroes: nothing has been observed about it, and a row of zeroes is a
   * claim.
   */
  async readings(now: Date = new Date()): Promise<QuotaRunnerReading[]> {
    const windows = await this.prisma.quotaWindow.findMany({
      where: { resetsAt: { gt: now } },
      // Soonest reset first: the nearest ceiling is the one most likely to
      // bind, and it should be the first thing read.
      orderBy: [{ runnerKey: 'asc' }, { resetsAt: 'asc' }],
    });
    if (windows.length === 0) return [];

    const spans = windows.map((window) => ({
      window,
      span: windowSpan(window),
    }));
    const consumption = await this.loadConsumption(spans, now);

    // Both halves accumulate in one pass, keyed on the runner and ordered by
    // the query above: the meter rows `meterQuotaPosition` collapses, and the
    // per-window readings a screen lists underneath the answer it gives.
    const meters = groupByRunner(windows, (window) => window.runnerKey);
    const byRunner = new Map<string, QuotaWindowReading[]>();
    for (const { window, span } of spans) {
      const readings = byRunner.get(window.runnerKey) ?? [];
      readings.push(reading(window, span, now, consumption));
      byRunner.set(window.runnerKey, readings);
    }

    return [...byRunner.entries()].map(([runnerKey, readings]) => ({
      runnerKey,
      // Routing's own rule, called rather than restated. See the method doc.
      position:
        meterQuotaPosition(
          (meters.get(runnerKey) ?? []).map((window) => ({
            kind: window.kind,
            resetsAt: window.resetsAt,
            pressure: window.pressure as QuotaPressure,
            lastObservedAt: window.lastObservedAt,
          })),
          now,
        ) ?? null,
      windows: readings,
    }));
  }

  /**
   * Consumption rows for every live window, in a fixed number of queries.
   *
   * ## Why this is not the aggregate-per-window it replaces
   *
   * The previous shape ran three aggregates PER RUNNER, which #301's
   * acceptance criteria call out as N+1 — and returning every window rather
   * than one would have made it three per WINDOW, several times worse in
   * exactly the direction the issue was filed about. So the rows are fetched
   * once over the union of the spans and bucketed here.
   *
   * Two queries, whatever the fleet size, on top of the one that read the
   * windows. Each window still gets its OWN span: the union is only what is
   * asked of Postgres, never what is summed into a reading.
   *
   * ## What this costs, stated rather than assumed
   *
   * The union span is as wide as the longest live window, so a `weekly` row
   * makes it a week. The event query is narrowed to rows that carry a cost or
   * a token count, which is lossless — an event with all three null adds
   * nothing to any sum and is not counted by `reportedUsd`'s non-null tally —
   * and it excludes the progress and log events that dominate the table. If a
   * fleet ever grows to where a week of cost-bearing events is too much to
   * hold, the answer is a rollup table, not a return to per-runner aggregates.
   */
  private async loadConsumption(
    spans: readonly { window: { runnerKey: string }; span: WindowSpan }[],
    now: Date,
  ): Promise<ConsumptionRows> {
    const runnerKeys = [
      ...new Set(spans.map((entry) => entry.window.runnerKey)),
    ];
    const earliest = spans.reduce(
      (soonest, entry) =>
        entry.span.startedAt < soonest ? entry.span.startedAt : soonest,
      spans[0]!.span.startedAt,
    );

    const [runs, events] = await Promise.all([
      this.prisma.run.findMany({
        where: {
          runnerKey: { in: runnerKeys },
          startedAt: { gte: earliest, lte: now },
        },
        select: { runnerKey: true, startedAt: true, costUsd: true },
      }),
      this.prisma.runEvent.findMany({
        where: {
          occurredAt: { gte: earliest, lte: now },
          run: { runnerKey: { in: runnerKeys } },
          // Lossless narrowing: an event reporting none of the three cannot
          // change a sum or the count that separates "unreported" from "zero".
          OR: [
            { costUsd: { not: null } },
            { tokensInput: { not: null } },
            { tokensOutput: { not: null } },
          ],
        },
        select: {
          occurredAt: true,
          costUsd: true,
          tokensInput: true,
          tokensOutput: true,
          run: { select: { runnerKey: true } },
        },
      }),
    ]);

    return {
      runs: groupByRunner(runs, (run) => run.runnerKey),
      events: groupByRunner(events, (event) => event.run.runnerKey),
    };
  }

  /** The peak already stored for a window, or `unknown` if there is no row. */
  private async storedPeak(
    runnerKey: string,
    kind: string,
    resetsAt: Date,
  ): Promise<QuotaPressure> {
    const existing = await this.prisma.quotaWindow.findUnique({
      where: { runnerKey_kind_resetsAt: { runnerKey, kind, resetsAt } },
      select: { peakPressure: true },
    });
    return (existing?.peakPressure as QuotaPressure | undefined) ?? 'unknown';
  }
}

/** Consumption Opifex ITSELF put through a window. Never the window's total. */
export interface OpifexConsumption {
  /** Runs of this runner that started inside the span. */
  runs: number;
  /** How many of them reported no cost — read together with `reportedUsd`. */
  runsWithoutCost: number;
  /** Null, never 0, when no event in the span reported a cost. */
  reportedUsd: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
}

/**
 * One runner's whole quota position: every live window, and the one that binds.
 *
 * Both halves, because either alone misleads. `position` alone hides which
 * ceiling is doing the binding and what the others say; `windows` alone leaves
 * the reader to work out which one governs, which is the arithmetic #301 was
 * filed about getting wrong.
 */
export interface QuotaRunnerReading {
  runnerKey: string;
  /**
   * Which window binds, from routing's own {@link meterQuotaPosition}.
   *
   * Null is UNKNOWN, never healthy: every live window read `unknown`, or the
   * only non-exhausted readings are staler than the meter's health horizon.
   */
  position: RunnerQuotaPosition | null;
  /** Every window that has not yet rolled, soonest reset first. */
  windows: QuotaWindowReading[];
}

/** One live vendor window, and what went through it. */
export interface QuotaWindowReading {
  /** The vendor's own label, verbatim: `five_hour`, `weekly`, `unknown`. */
  windowKind: string;
  resetsAt: string;
  startedAt: string;
  startedAtBasis: WindowStartBasis;
  partialWindow: boolean;
  pressure: QuotaPressure;
  peakPressure: QuotaPressure;
  lastObservedAt: string;
  observations: number;
  opifexConsumption: OpifexConsumption;
  /** Always null. The ratio is not computable; see `quota-window.ts`. */
  burnFraction: null;
  basis: string;
}

/** Cost- and token-bearing rows for the union span, bucketed by runner key. */
interface ConsumptionRows {
  runs: Map<string, RunRow[]>;
  events: Map<string, EventRow[]>;
}

interface RunRow {
  startedAt: Date;
  costUsd: DecimalLike | number | null;
}

interface EventRow {
  occurredAt: Date;
  costUsd: DecimalLike | number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
}

/**
 * One window's reading, folded from rows already in memory.
 *
 * A free function rather than a method: it touches no injected dependency now
 * that the queries are batched, and keeping it out of the class is what makes
 * "this does not go back to the database" checkable by reading the signature.
 */
function reading(
  window: {
    runnerKey: string;
    kind: string;
    resetsAt: Date;
    pressure: string;
    peakPressure: string;
    lastObservedAt: Date;
    observations: number;
  },
  span: WindowSpan,
  now: Date,
  rows: ConsumptionRows,
): QuotaWindowReading {
  // Clipped at `now`: a window runs into the future, and summing to its reset
  // instant would present a partial window as a whole one.
  const until = window.resetsAt < now ? window.resetsAt : now;
  const inSpan = (at: Date) => at >= span.startedAt && at <= until;

  const runs = (rows.runs.get(window.runnerKey) ?? []).filter((run) =>
    inSpan(run.startedAt),
  );
  const events = (rows.events.get(window.runnerKey) ?? []).filter((event) =>
    inSpan(event.occurredAt),
  );

  const costs = events
    .map((event) => toNumberOrNull(event.costUsd))
    .filter((cost): cost is number => cost !== null);

  return {
    windowKind: window.kind,
    resetsAt: window.resetsAt.toISOString(),
    startedAt: span.startedAt.toISOString(),
    startedAtBasis: span.startedAtBasis,
    partialWindow: span.partial,
    pressure: window.pressure as QuotaPressure,
    peakPressure: window.peakPressure as QuotaPressure,
    lastObservedAt: window.lastObservedAt.toISOString(),
    observations: window.observations,
    opifexConsumption: {
      runs: runs.length,
      runsWithoutCost: runs.filter((run) => run.costUsd === null).length,
      // Null rather than 0 when NO event in the span reported a cost. The
      // empty-list case is what distinguishes "nothing reported" from
      // "reported zero", which a runner genuinely can do on a turn that did no
      // work.
      reportedUsd: costs.length > 0 ? toCents(sum(costs)) : null,
      tokensInput: sumOrNull(events.map((event) => event.tokensInput)),
      tokensOutput: sumOrNull(events.map((event) => event.tokensOutput)),
    },
    // Always null, and a field rather than an omission. See
    // `quota-window.ts`: the capacity to divide by does not exist, and the
    // numerator above is Opifex's share of a shared subscription. Naming it
    // as unavailable is the same discipline `metrics.service.ts` applies by
    // returning NOT_MEASURED instead of 0 — an absent key reads as an
    // oversight, and this one is a decision.
    burnFraction: null,
    basis: describeBasis(window.kind, span.startedAtBasis, span.partial),
  };
}

function groupByRunner<T>(rows: readonly T[], key: (row: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(key(row));
    if (bucket) bucket.push(row);
    else grouped.set(key(row), [row]);
  }
  return grouped;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Null when NOTHING reported, which is not the same claim as a sum of zero. */
function sumOrNull(values: readonly (number | null)[]): number | null {
  const reported = values.filter((value): value is number => value !== null);
  return reported.length > 0 ? sum(reported) : null;
}

/**
 * To the precision the column actually stores.
 *
 * `run_events.cost_usd` is `Decimal(10,4)`, and adding four-decimal values as
 * JS numbers produces tails like `12.000000000000002`. Postgres used to do
 * this addition; folding the rows in memory is what bought the fixed query
 * count, and rounding back to the column's own scale is what keeps that trade
 * free of a visible artefact. Same argument as `cost.service.ts`'s `round`,
 * two places further right because this figure is not yet a display value.
 */
function toCents(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function describeBasis(
  kind: string,
  startBasis: WindowStartBasis,
  partial: boolean,
): string {
  const window =
    startBasis === 'vendor-window-length'
      ? `the vendor's "${kind}" window`
      : `the vendor's "${kind}" window, measured from the first sighting because ` +
        'no length is known for that label';

  const floor = partial
    ? ' Consumption is a FLOOR for this window: anything that ran before the ' +
      'first sighting is inside the window and outside the sum.'
    : '';

  return (
    `Opifex's own runs against ${window}.${floor} It is not the window's total ` +
    'consumption — VISION §11 shares this subscription with the operator, whose ' +
    'interactive use burns the same window and is not observable here — and there ' +
    'is no published capacity to express it as a fraction of.'
  );
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
