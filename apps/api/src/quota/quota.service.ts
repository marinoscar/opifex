import { Injectable, Logger } from '@nestjs/common';

import { toNumberOrNull } from '../common/decimal';
import { PrismaService } from '../prisma/prisma.service';
import type { RunnerQuotaObservation } from '../runners/runner.types';
import {
  collapseObservations,
  windowSpan,
  worsePressure,
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
 * correct a window that has already been read rather than being lost.
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
   * The current window per runner, with Opifex's own consumption through it.
   *
   * "Current" means the newest window whose reset instant is still ahead of
   * `now`. A runner with no such window is ABSENT from the result rather than
   * present with zeroes: nothing has been observed about it, and a row of
   * zeroes is a claim.
   */
  async readings(now: Date = new Date()): Promise<QuotaReading[]> {
    const windows = await this.prisma.quotaWindow.findMany({
      where: { resetsAt: { gt: now } },
      orderBy: [{ runnerKey: 'asc' }, { resetsAt: 'desc' }],
    });

    // The newest live window per runner. Ordered above, so the first one seen
    // for a key is the one to keep.
    const current = new Map<string, (typeof windows)[number]>();
    for (const window of windows) {
      if (!current.has(window.runnerKey)) current.set(window.runnerKey, window);
    }

    return Promise.all(
      [...current.values()].map((window) => this.reading(window, now)),
    );
  }

  private async reading(
    window: {
      runnerKey: string;
      kind: string;
      resetsAt: Date;
      pressure: string;
      peakPressure: string;
      firstObservedAt: Date;
      lastObservedAt: Date;
      observations: number;
    },
    now: Date,
  ): Promise<QuotaReading> {
    const span = windowSpan(window);
    // Clipped at `now`: a window runs into the future, and summing to its
    // reset instant would present a partial window as a whole one.
    const until = window.resetsAt < now ? window.resetsAt : now;

    const [events, runs, runsWithoutCost] = await Promise.all([
      this.prisma.runEvent.aggregate({
        where: {
          occurredAt: { gte: span.startedAt, lte: until },
          run: { runnerKey: window.runnerKey },
        },
        _sum: { costUsd: true, tokensInput: true, tokensOutput: true },
        _count: { costUsd: true },
      }),
      this.prisma.run.count({
        where: {
          runnerKey: window.runnerKey,
          startedAt: { gte: span.startedAt, lte: until },
        },
      }),
      this.prisma.run.count({
        where: {
          runnerKey: window.runnerKey,
          startedAt: { gte: span.startedAt, lte: until },
          costUsd: null,
        },
      }),
    ]);

    // Null rather than 0 when NO event in the span reported a cost. Prisma's
    // `_sum` of an all-null column is null already; the count is what
    // distinguishes "nothing reported" from "reported zero", which a runner
    // genuinely can do on a turn that did no work.
    const reported = events._count.costUsd > 0;

    return {
      runnerKey: window.runnerKey,
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
        runs,
        runsWithoutCost,
        reportedUsd: reported ? toNumberOrNull(events._sum.costUsd) : null,
        tokensInput: events._sum.tokensInput,
        tokensOutput: events._sum.tokensOutput,
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

/** One runner's current vendor window, and what went through it. */
export interface QuotaReading {
  runnerKey: string;
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
