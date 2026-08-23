import { Injectable } from '@nestjs/common';

import { HardSpendCeilingService } from '../budget/hard-spend-ceiling';
import { SpendLedgerService } from '../budget/spend-ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { toNumberOrNull } from '../common/decimal';
import { COST_DEFAULT_DAYS, type CostSummary } from './dto/cost.dto';

/**
 * Spend, with the part that is unknown counted rather than hidden.
 *
 * ## Why one query and not four aggregates
 *
 * The totals, the per-repository split and the per-day series are all
 * reductions over the same set of runs, and `Run.costUsd` is nullable — so an
 * SQL `SUM` would silently skip the nulls and give a total with no way to say
 * how many rows it skipped. Reading the rows once and reducing in code is what
 * makes `runsWithoutCost` available at all, and a window of runs is small
 * enough that the aggregate is not worth the blindness.
 *
 * ## Quota is not measured, and is not approximated
 *
 * The same refusal #165 made for `quotaBurn`. VISION §11's shared quota is the
 * agent subscription; `RunEvent.blockedUntil` records a reset TIME, never
 * consumption against a capacity. The GitHub rate limit IS measured and could
 * be divided by its window — that would answer a different question while
 * wearing this one's label.
 */
@Injectable()
export class CostService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ceiling: HardSpendCeilingService,
    private readonly ledger: SpendLedgerService,
  ) {}

  async summary(days: number = COST_DEFAULT_DAYS): Promise<CostSummary> {
    const to = new Date();
    const from = new Date(to.getTime() - days * DAY_MS);

    // Tallied over the CEILING's window, not `days`. The caller picks the
    // window for the screen; the ceiling brought its own, and a headroom
    // figure computed over the wrong one would be wrong in a way nothing on
    // screen could reveal.
    const ceiling = this.ceiling.value;
    const ceilingSpend = await this.ledger.tally(ceiling.windowDays, to);

    const runs = await this.prisma.run.findMany({
      where: { startedAt: { gte: from, lte: to } },
      select: {
        startedAt: true,
        costUsd: true,
        workOrder: { select: { repository: { select: { owner: true, name: true } } } },
      },
      orderBy: { startedAt: 'asc' },
    });

    const withCost = runs
      .map((run) => ({ ...run, cost: toNumberOrNull(run.costUsd) }))
      .filter((run): run is typeof run & { cost: number } => run.cost !== null);

    const byRepository = new Map<string, { total: number; runs: number; without: number }>();
    for (const run of runs) {
      const key = `${run.workOrder.repository.owner}/${run.workOrder.repository.name}`;
      const entry = byRepository.get(key) ?? { total: 0, runs: 0, without: 0 };
      const cost = toNumberOrNull(run.costUsd);

      entry.runs += 1;
      if (cost === null) entry.without += 1;
      else entry.total += cost;
      byRepository.set(key, entry);
    }

    const byDay = new Map<string, number>();
    for (const run of withCost) {
      const date = run.startedAt.toISOString().slice(0, 10);
      byDay.set(date, (byDay.get(date) ?? 0) + run.cost);
    }

    return {
      generatedAt: to.toISOString(),
      window: { from: from.toISOString(), to: to.toISOString() },
      // Null, not 0, when nothing reported a cost. "No run reported a cost"
      // and "the factory spent nothing" are different claims, and only one of
      // them is ever true of a factory that has run something.
      totalUsd: withCost.length === 0 ? null : round(sum(withCost.map((run) => run.cost))),
      runs: runs.length,
      runsWithoutCost: runs.length - withCost.length,
      byRepository: [...byRepository]
        .map(([repository, entry]) => ({
          repository,
          // Same rule per repository: a repository whose every run reported
          // nothing has an unknown spend, not a zero one.
          totalUsd: entry.without === entry.runs ? null : round(entry.total),
          runs: entry.runs,
          runsWithoutCost: entry.without,
        }))
        // Biggest spender first, with the unknowns last rather than at the
        // top: a null sorting high would put the least informative row where
        // the eye lands.
        .sort((a, b) => (b.totalUsd ?? -1) - (a.totalUsd ?? -1)),
      // Only days with reported spend, oldest first — the same rule the
      // metrics trend follows. A zero for a quiet day would draw a line
      // claiming the factory ran for free.
      byDay: [...byDay]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, total]) => ({ date, totalUsd: round(total) })),
      quota: null,
      ceiling: {
        limitUsd: ceiling.limitUsd,
        windowDays: ceiling.windowDays,
        malformed: ceiling.malformed,
        spend: {
          reportedUsd: ceilingSpend.reportedUsd,
          estimatedUsd: ceilingSpend.estimatedUsd,
          totalUsd: ceilingSpend.totalUsd,
          runsWithoutCost: ceilingSpend.runsWithoutCost,
          unboundedRuns: ceilingSpend.unboundedRuns,
        },
        // Null rather than the full limit when none is configured. There is no
        // headroom under a ceiling that does not exist -- dispatch refuses in
        // that state -- and reporting the limit as headroom would draw a full
        // bar over a factory that cannot spend a cent.
        headroomUsd:
          ceiling.limitUsd === null
            ? null
            : round(Math.max(0, ceiling.limitUsd - ceilingSpend.totalUsd)),
      },
    };
  }
}

// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * To cents.
 *
 * Floating-point addition over a column stored as `Decimal(10,4)` produces
 * tails like `12.000000000000002`, and a cost screen showing that has lost the
 * reader's trust over an artefact of the language rather than a real number.
 * Four decimal places go in, two come out — the precision a dollar figure is
 * read at.
 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
