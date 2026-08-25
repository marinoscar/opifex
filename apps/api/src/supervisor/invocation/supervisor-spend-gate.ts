import type { HardCeiling } from '../../budget/hard-spend-ceiling';
import { SUPERVISOR_SPEND_CEILING_ENV } from './supervisor-spend-ceiling';
import type { SupervisorSpendTally } from './supervisor-spend-ledger.service';

/**
 * May the supervisor spend anything right now? (#261, ADR-0017.)
 *
 * A pure function over two facts — the ceiling and the tally — so the whole
 * truth table is testable without a database, a clock or a Nest container, and
 * so the decision that produced a `skipped_budget` row is reconstructable from
 * the row.
 *
 * ## Why this is not in `quota-gate.ts`
 *
 * That file's header states its own identity in words chosen for exactly this
 * question: "this gate reads STATE rather than any budget". A spend check is a
 * budget check by definition, and putting it there would falsify the sentence
 * the file leads with — the same category of error ADR-0015 and ADR-0016 each
 * spent a document correcting elsewhere in that same file. ADR-0016 also
 * narrowed `assessQuota`'s signature to `Pick<SnapshotTotals, 'runsBlocked'>`
 * specifically so "the gate cannot regrow a `runsRunning` branch without the
 * signature changing in a diff"; adding a dollar figure to it is the shape of
 * change that guard exists to make visible.
 *
 * There is also a mechanical reason the two cannot merge: `assessQuota` is
 * pure over a snapshot taken ONCE, and this gate is called a second time
 * mid-invocation, against figures produced by calls made within the very
 * invocation it is judging. Two files, called from two points in
 * `SupervisorService.invoke()`, keeps each contract honest about what kind of
 * check it is.
 *
 * ## No `OrderBudget`
 *
 * `decideSpendAdmission` projects an order's authorized ceiling on top of the
 * tally, because a work order carries one. A supervisor tick carries no
 * per-tick authorization, so there is nothing to project with and the question
 * is only "may this tick spend at all". That absence is why this is a sibling
 * function rather than a call into that one.
 *
 * Every refusal names its figures. A gate that says "budget exceeded" without
 * saying "$5.02 spent of $5.00 over 1 day" is one an operator has to read the
 * source to trust.
 */

/**
 * Why the supervisor was not allowed to spend.
 *
 * Two values, because they call for different operator actions: the first
 * means "set the variable, or fix what you set"; the second means "wait for
 * the window to roll, or raise the ceiling deliberately".
 */
export type SupervisorSpendRefusal =
  'no-supervisor-spend-ceiling-configured' | 'supervisor-spend-ceiling-reached';

export type SupervisorSpendVerdict =
  | { admit: true; headroomUsd: number; reason: string }
  | { admit: false; refusal: SupervisorSpendRefusal; reason: string };

/**
 * The rules, in the order they are applied. Order matters:
 *
 * 1. **A malformed ceiling is not an absent one.** Reported as its own case,
 *    because it is the case where somebody believed they had set a limit.
 * 2. **No ceiling refuses rather than permits.** `decideSpendAdmission`'s
 *    precedent, applied for a reason specific to this moment rather than by
 *    analogy: ADR-0016 removed the only other thing that ever stood the
 *    supervisor down for a spend-adjacent reason, and #261 exists because
 *    nothing bounds supervisor spend today. "Unset means unlimited" is that
 *    bug restated as a default, and VISION §3.5 gates on reversibility —
 *    spend is not reversible, so the unbounded case does not proceed.
 * 3. **Already at the ceiling refuses.** `reportedUsd >= limit`, naming the
 *    figures. The tally may be a floor (see `unpricedCalls`), and a floor at
 *    or above the limit is still at or above the limit.
 * 4. **Otherwise admit, reporting headroom.**
 *
 * ## The gap this leaves, stated rather than hidden
 *
 * Unpriced calls contribute nothing to `reportedUsd` and do not refuse on
 * their own. So a run of calls to a model outside `MODEL_RATES` is
 * under-bounded by this ceiling until that table is updated — the drift its
 * own header already accepts as inevitable. Closing that gap would mean
 * refusing to run on an unpriced model at all, which converts an ordinary,
 * expected event into an indefinite outage of the whole supervisor: a worse
 * failure than an under-bounded floor, and the "halt forever" outcome this
 * decision is explicitly told to avoid. The gap is bounded and it is always
 * SAID — every reason string below reports the unpriced count whenever there
 * is one.
 */
export function assessSupervisorSpend(
  ceiling: HardCeiling,
  tally: SupervisorSpendTally,
): SupervisorSpendVerdict {
  const window = `${tally.window.days}d`;

  if (ceiling.malformed !== null) {
    return {
      admit: false,
      refusal: 'no-supervisor-spend-ceiling-configured',
      reason:
        `${SUPERVISOR_SPEND_CEILING_ENV} is set to ${JSON.stringify(ceiling.malformed)}, ` +
        `which is not a non-negative number. The supervisor refuses to spend against a ` +
        `ceiling that cannot be read.`,
    };
  }

  if (ceiling.limitUsd === null) {
    return {
      admit: false,
      refusal: 'no-supervisor-spend-ceiling-configured',
      reason:
        `No supervisor spend ceiling is configured. Set ${SUPERVISOR_SPEND_CEILING_ENV} to ` +
        `the most you are willing to spend on supervision per ${window}. It is separate from ` +
        `OPIFEX_HARD_SPEND_CEILING_USD, which bounds what dispatch spends on runs.`,
    };
  }

  const limit = ceiling.limitUsd;
  const spent = describeSupervisorSpend(tally);

  if (tally.reportedUsd >= limit) {
    return {
      admit: false,
      refusal: 'supervisor-spend-ceiling-reached',
      reason:
        `Supervisor spend ceiling reached: ${spent} against a ${window} ceiling of ` +
        `${usd(limit)}. This ceiling cannot be raised at runtime.`,
    };
  }

  return {
    admit: true,
    headroomUsd: round(limit - tally.reportedUsd),
    reason:
      `${usd(round(limit - tally.reportedUsd))} of headroom under the ${window} supervisor ` +
      `ceiling of ${usd(limit)} (${spent}).`,
  };
}

/**
 * The window's tally plus what THIS tick has spent so far.
 *
 * The between-proposers check needs a figure the stored tally cannot contain:
 * the invocation being judged has not been written yet, so its cost exists
 * only in memory. Adding it here, and re-running the same gate, is what keeps
 * one set of rules and one reason vocabulary for both checkpoints — the
 * alternative is a second, subtly different comparison written inline in the
 * loop, which is how two gates end up disagreeing.
 *
 * This check is genuinely reachable, unlike `decideBudgetOverrun`'s
 * `stoppable` arm, which that file documents as unreachable for
 * `claude-code-local` because a run reports its cost once, on the final line,
 * after the money is gone. A supervisor tick is a short, enumerable sequence:
 * each proposer makes at most one `ask()`, and `priceUsd()` resolves
 * synchronously the instant that call returns — before the next proposer is
 * invoked.
 */
export function withTickSpend(
  tally: SupervisorSpendTally,
  spentThisTickUsd: number,
  unpricedThisTick: number,
): SupervisorSpendTally {
  return {
    ...tally,
    reportedUsd: round(tally.reportedUsd + spentThisTickUsd),
    unpricedCalls: tally.unpricedCalls + unpricedThisTick,
  };
}

// ---------------------------------------------------------------------------

/**
 * The spend figure, saying what kind of figure it is.
 *
 * Two shapes rather than `describeSpend`'s three, because there is no
 * estimated leg here: a measurement, or a measurement that is explicitly a
 * floor. The floor case is the one that must never be silent — a floor read as
 * a total is how a ceiling gets passed with nothing appearing to go wrong.
 */
function describeSupervisorSpend(tally: SupervisorSpendTally): string {
  const measured = `spent ${usd(tally.reportedUsd)} across ${tally.invocations} invocation(s)`;

  if (tally.unpricedCalls === 0) return measured;

  return (
    `${measured}, plus an unknown amount across ${tally.unpricedCalls} model call(s) the ` +
    `price table has no rate for — so this figure is a floor, not a total`
  );
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
