import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/**
 * What the factory has spent, with the unmeasured part counted rather than
 * dropped (#65).
 *
 * ## Why this is not `CostService`
 *
 * `cockpit/cost.service.ts` answers "what did we spend?" for a human reading a
 * screen, and its honesty rule is that an unknown is reported as `null` — "no
 * run reported a cost" and "the factory spent nothing" are different claims,
 * and it refuses to conflate them.
 *
 * This answers a different question: "may we spend more?" For a ceiling, a
 * `null` cannot be reported and left to the reader — the gate has to decide.
 * Dropping unmeasured runs would make the ceiling decorative, which is exactly
 * what `schemas/runner-capability.schema.json` says about `reportsCost`: *"a
 * runner that cannot report cost must not look like one that spent nothing, or
 * a budget ceiling becomes decorative."*
 *
 * So the two coexist deliberately, and neither should be rewritten in terms of
 * the other. The read model must not round unknowns up (it would overstate
 * spend on a screen); the gate must not round them down (it would let spend
 * escape the ceiling).
 *
 * ## How an unmeasured run is counted
 *
 * At the work order's own `budgetCeilingUsd` — the most that run was ever
 * authorized to spend. That is an upper bound rather than a guess: no invented
 * per-run average appears anywhere in this file, because a number nobody
 * measured, presented in the same total as numbers that were measured, is the
 * "synthesized event masquerading as a report" of VISION §9 in dollar form.
 *
 * A run with neither a reported cost nor an authorized ceiling cannot be
 * bounded at all. Those are counted in `unboundedRuns` and NOT folded into a
 * number, which is what makes `totalUsd` honest: with `unboundedRuns > 0` it
 * is a floor, not a total, and the gate says so in its reason line.
 */

/** The rolling window a tally covers. */
export interface SpendWindow {
  from: Date;
  to: Date;
  days: number;
}

export interface SpendTally {
  /** Measured. The sum of runs that actually reported a cost. */
  reportedUsd: number;
  /**
   * ESTIMATED. The sum of authorized ceilings for runs that reported nothing.
   *
   * Named separately from `reportedUsd` at every layer it passes through, per
   * #65's fourth acceptance criterion: an estimate that arrives in the same
   * field as a measurement stops being distinguishable one call later.
   */
  estimatedUsd: number;
  /**
   * `reportedUsd + estimatedUsd`.
   *
   * A FLOOR rather than a total whenever `unboundedRuns` is above zero. Read
   * the two together or not at all.
   */
  totalUsd: number;
  /** Runs started inside the window. */
  runs: number;
  /** How many of them reported no cost. */
  runsWithoutCost: number;
  /**
   * Runs with no reported cost AND no ceiling to bound them with.
   *
   * Above zero means the factory has spent an amount nobody can put a number
   * to. Surfaced rather than blocking: refusing on history would deadlock an
   * install permanently on rows written before this existed. What it must
   * never do is silently contribute zero.
   */
  unboundedRuns: number;
  window: SpendWindow;
}

@Injectable()
export class SpendLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tally spend over the trailing `days`.
   *
   * Rows are read and reduced in code rather than aggregated in SQL for the
   * same reason `CostService` does it: `SUM` over a nullable column skips the
   * nulls and gives no way to say how many it skipped, and the count of what
   * was skipped is the entire point here.
   *
   * `now` is injected rather than read from the clock so the window is
   * deterministic under test — #65 requires this be deterministic and
   * unit-tested, and a gate whose boundary cannot be pinned to an instant
   * cannot be tested at its boundary.
   */
  async tally(days: number, now: Date = new Date()): Promise<SpendTally> {
    const from = new Date(now.getTime() - days * DAY_MS);

    const runs = await this.prisma.run.findMany({
      where: { startedAt: { gte: from, lte: now } },
      select: {
        costUsd: true,
        workOrder: { select: { budgetCeilingUsd: true } },
      },
    });

    let reportedUsd = 0;
    let estimatedUsd = 0;
    let runsWithoutCost = 0;
    let unboundedRuns = 0;

    for (const run of runs) {
      const cost = toNumber(run.costUsd);
      if (cost !== null) {
        reportedUsd += cost;
        continue;
      }

      runsWithoutCost += 1;

      const ceiling = toNumber(run.workOrder?.budgetCeilingUsd ?? null);
      if (ceiling === null) {
        unboundedRuns += 1;
        continue;
      }
      estimatedUsd += ceiling;
    }

    return {
      reportedUsd: round(reportedUsd),
      estimatedUsd: round(estimatedUsd),
      totalUsd: round(reportedUsd + estimatedUsd),
      runs: runs.length,
      runsWithoutCost,
      unboundedRuns,
      window: { from, to: now, days },
    };
  }
}

// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Prisma `Decimal` to `number`, defensively.
 *
 * #167 found the same column being converted two different ways in two
 * services — `.toNumber()` in one and `Number()` in the other — and only one
 * of them worked. This accepts either shape rather than assuming, because a
 * silent `NaN` inside a spend ceiling propagates into every comparison and
 * makes each one false: `NaN >= limit` is `false`, so a broken conversion here
 * would read as "plenty of headroom" and open the gate.
 */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object' && 'toNumber' in value) {
    const converted = (value as { toNumber(): number }).toNumber();
    return Number.isFinite(converted) ? converted : null;
  }
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}

/** To cents, matching the cockpit read model so the two never disagree by a tail. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
