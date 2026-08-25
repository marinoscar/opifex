import { Injectable } from '@nestjs/common';

import type { SpendWindow } from '../../budget/spend-ledger.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * What the supervisor has spent on itself (#261, ADR-0017).
 *
 * ## Why this is not `SpendLedgerService`
 *
 * That one sums `Run.costUsd` with no `runnerKey` filter — it is fleet-wide by
 * construction, and it answers "what may dispatch still spend on runs". This
 * one reads `SupervisorInvocation` and NOTHING else.
 *
 * The separation is not incidental. `schema.prisma` already states, on the
 * column itself, that `SupervisorInvocation.costUsd` is "SEPARATE from
 * `Run.costUsd` by construction — a different table entirely — because #89
 * requires supervisor cost never distort success metric 5". A tally that added
 * the two together would be the first place in this codebase those columns are
 * summed for any purpose, and once such a figure exists it is the number the
 * next dashboard, alert or metric reaches for. The schema drew that boundary
 * deliberately; this file stays on its side of it.
 *
 * ## Why there is no `estimatedUsd`
 *
 * `SpendLedgerService` has three legs because a work order carries an
 * operator-authorized `budgetCeilingUsd` — a figure somebody actually set,
 * which is an honest upper bound to stand in for a run that reported nothing.
 * A supervisor tick has no equivalent per-call authorization, so there is
 * nothing honest to estimate FROM, and this tally does not invent one. Two
 * legs only: what was measured, and how much was not.
 *
 * ## Rows are reduced in code, not SUMmed in SQL
 *
 * The same reason `SpendLedgerService` and `CostService` both do it: `SUM` over
 * a nullable column drops the nulls and gives no way to say how many it
 * dropped, and the count of what was dropped is the entire point of a ceiling.
 */

export interface SupervisorSpendTally {
  /** MEASURED. The sum of `costUsd` for invocations that reported one. */
  reportedUsd: number;
  /**
   * Model calls inside the window that priced at null (#282).
   *
   * Above zero, `reportedUsd` is a FLOOR and not a total — real spend happened
   * that `model-pricing.ts` had no rate to convert. Counted rather than
   * folded in at zero, and never blocking on its own: refusing to run on an
   * unpriced model would turn an ordinary event (Anthropic ships a model, the
   * hand-maintained table has not caught up) into an indefinite supervisor
   * outage, which is a worse failure than an under-bounded floor. The gate
   * says so in its reason line instead.
   */
  unpricedCalls: number;
  /** Invocations that started inside the window, of every outcome. */
  invocations: number;
  window: SpendWindow;
}

/**
 * A tally with nothing in it, for the case where no query is worth making.
 *
 * When no ceiling is configured the gate refuses on the ceiling alone, and
 * asking the database what has been spent would be work whose answer cannot
 * change the verdict. The window is still carried, because the refusal names
 * it — an operator told "set a ceiling" also needs to be told per what.
 */
export function noSupervisorSpendTally(
  days: number,
  now: Date,
): SupervisorSpendTally {
  return {
    reportedUsd: 0,
    unpricedCalls: 0,
    invocations: 0,
    window: { from: new Date(now.getTime() - days * DAY_MS), to: now, days },
  };
}

@Injectable()
export class SupervisorSpendLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tally supervisor spend over the trailing `days`.
   *
   * `now` is injected rather than read from the clock, so the window is
   * deterministic under test — a gate whose boundary cannot be pinned to an
   * instant cannot be tested at its boundary.
   */
  async tally(
    days: number,
    now: Date = new Date(),
  ): Promise<SupervisorSpendTally> {
    const from = new Date(now.getTime() - days * DAY_MS);

    const invocations = await this.prisma.supervisorInvocation.findMany({
      where: { startedAt: { gte: from, lte: now } },
      select: { costUsd: true, unpricedCalls: true },
    });

    let reportedUsd = 0;
    let unpricedCalls = 0;

    for (const invocation of invocations) {
      reportedUsd += toNumber(invocation.costUsd) ?? 0;
      unpricedCalls += invocation.unpricedCalls;
    }

    return {
      reportedUsd: round(reportedUsd),
      unpricedCalls,
      invocations: invocations.length,
      window: { from, to: now, days },
    };
  }
}

// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Prisma `Decimal` to `number`, defensively.
 *
 * The same conversion `SpendLedgerService` guards, for the same reason it
 * documents: #167 found one column converted two different ways in two
 * services, and only one worked. A silent `NaN` inside a ceiling makes every
 * comparison false — `NaN >= limit` is `false` — so a broken conversion would
 * read as "plenty of headroom" and open the gate.
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

/** To cents, matching every other spend figure so the two never disagree by a tail. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
