import { HARD_SPEND_CEILING_ENV, type HardCeiling } from './hard-spend-ceiling';
import type { SpendTally } from './spend-ledger.service';

/**
 * May this work order be dispatched, given what has already been spent? (#65)
 *
 * A pure function over three facts — the ceiling, the tally, and what the
 * order authorizes — so the decision is deterministic and its whole truth
 * table is testable without a database, a clock or a Nest container. #65's
 * fifth acceptance criterion asks for exactly that, and VISION §3.6 puts
 * enforcement in deterministic policy rather than in an agent's judgement.
 *
 * Every refusal names the figure that produced it. A gate that says "budget
 * exceeded" and not "spent $47.20 of $50.00, and this order authorizes up to
 * $10.00" is one an operator has to read the source to trust.
 */

/** What the order being considered would be allowed to spend. */
export interface OrderBudget {
  /** The order's own ceiling. Null means it names none. */
  ceilingUsd: number | null;
  /**
   * Whether the runner it would go to reports cost.
   *
   * From the capability manifest (#32), not assumed. An order with no ceiling
   * heading for a runner that reports nothing can be bounded by neither the
   * order nor the runner, and is refused rather than dispatched blind.
   */
  runnerReportsCost: boolean;
}

/**
 * Why a work order was not admitted.
 *
 * Distinct values because they call for different operator actions: the first
 * means "wait, or raise the ceiling deliberately"; the second means "this
 * order or this runner is misconfigured" and waiting will never fix it.
 */
export type SpendRefusal =
  | 'no-hard-spend-ceiling-configured'
  | 'hard-spend-ceiling-reached'
  | 'work-order-cannot-be-budgeted';

export type SpendVerdict =
  | {
      admit: true;
      /** Ceiling minus tally. Null when the order names no ceiling to project. */
      headroomUsd: number;
      reason: string;
    }
  | { admit: false; refusal: SpendRefusal; reason: string };

/**
 * What a refused operator's next move is, in one sentence.
 *
 * The operator's next move on hitting a limit is to look for the knob, and the
 * message has to answer that before they go looking. Until #345 the answer was
 * "there isn't one, and that is deliberate" — the sentence read "This ceiling
 * cannot be raised at runtime", which was true: the value was frozen in a
 * `readonly` field with no setter anywhere in the process. ADR-0018 §6
 * replaced that structural guarantee with an access-controlled one, so the
 * sentence had to change or become a lie told at exactly the moment an
 * operator is trusting it.
 *
 * It still says the half that did not change, and says it first: no grant, no
 * promoted class, no agent. What it adds is who the knob belongs to.
 */
const WHO_RAISES_IT =
  'No trust grant, promoted action class or agent can raise this ceiling ' +
  '(VISION §8); a signed-in admin can, from the Control Center, and the ' +
  'change is recorded.';

/**
 * The rules, in the order they are applied. Order matters:
 *
 * 1. **A malformed ceiling is not an absent one.** Checked first, and reported
 *    as its own thing, because it is the case where somebody believed they
 *    had set a limit.
 * 2. **No ceiling refuses rather than permits**, and since ADR-0019 (#439)
 *    this rule is the whole of what stops a fresh install spending —
 *    `DISPATCH_ENABLED`, the runner and GitHub writes all ship ON, and this
 *    ships unset. A control plane that is ready but cannot spend is the
 *    intended shipped state, so this refusal is not an edge case reached by
 *    misconfiguration: it is the first thing every new deployment hits, and
 *    the message has to read that way. Running without naming a ceiling is
 *    the failure #65 names in its first sentence, and VISION §3.5 gates on
 *    reversibility — spend is not reversible, so the unbounded case does not
 *    proceed.
 * 3. **Already at the ceiling refuses**, before anything about this order is
 *    considered. The tally may be a floor (see `unboundedRuns`), and a floor
 *    at or above the limit is still at or above the limit.
 * 4. **An unbudgetable order refuses.** No ceiling on the order and no cost
 *    reporting from the runner means nothing downstream could ever stop it —
 *    slice 3's mid-run enforcement needs a reported figure to compare against,
 *    and there would be none.
 * 5. **A projected overshoot refuses.** `tally + ceiling > limit`, using the
 *    order's ceiling as what it MIGHT spend rather than what it probably will.
 *    A hard ceiling means spend above it does not happen, which requires
 *    reasoning about the worst case, not the expected one.
 *
 * ## The gap this leaves, stated rather than hidden
 *
 * An order with no ceiling of its own, heading for a runner that DOES report
 * cost, is admitted whenever the tally is below the limit — because there is
 * no figure to project with. It is then bounded only after the fact, by
 * mid-run enforcement against reported cost. That is a real gap: a single such
 * run can carry the tally past the ceiling before anything notices, and the
 * ceiling holds only from the next admission onward. Closing it properly means
 * requiring a ceiling on every order, which is #31's schema decision to make,
 * not this gate's.
 */
export function decideSpendAdmission(
  ceiling: HardCeiling,
  tally: SpendTally,
  order: OrderBudget,
): SpendVerdict {
  const window = `${tally.window.days}d`;

  if (ceiling.malformed !== null) {
    return {
      admit: false,
      refusal: 'no-hard-spend-ceiling-configured',
      reason:
        `${HARD_SPEND_CEILING_ENV} is set to ${JSON.stringify(ceiling.malformed)}, which is ` +
        `not a non-negative number. Refusing to spend against a ceiling that cannot be read.`,
    };
  }

  if (ceiling.limitUsd === null) {
    return {
      admit: false,
      refusal: 'no-hard-spend-ceiling-configured',
      reason:
        `No hard spend ceiling is configured. Set ${HARD_SPEND_CEILING_ENV} to the most you ` +
        `are willing to spend per ${window} before enabling dispatch.`,
    };
  }

  const limit = ceiling.limitUsd;
  const spent = describeSpend(tally);

  if (tally.totalUsd >= limit) {
    return {
      admit: false,
      refusal: 'hard-spend-ceiling-reached',
      reason:
        `Hard spend ceiling reached: ${spent} against a ${window} ceiling of ` +
        `${usd(limit)}. ${WHO_RAISES_IT}`,
    };
  }

  const headroom = round(limit - tally.totalUsd);

  if (order.ceilingUsd === null) {
    if (!order.runnerReportsCost) {
      return {
        admit: false,
        refusal: 'work-order-cannot-be-budgeted',
        reason:
          `This work order names no budget ceiling and its runner does not report cost, so ` +
          `nothing could bound or stop its spend. Give the order a budgetCeilingUsd, or route ` +
          `it to a runner that reports cost.`,
      };
    }

    // Admitted on headroom alone. See "the gap this leaves" above — this is
    // the branch that has one.
    return {
      admit: true,
      headroomUsd: headroom,
      reason:
        `${usd(headroom)} of headroom under the ${window} ceiling of ${usd(limit)} (${spent}). ` +
        `This order names no ceiling of its own; its spend is bounded only by the reported ` +
        `cost it is stopped on.`,
    };
  }

  const projected = round(tally.totalUsd + order.ceilingUsd);
  if (projected > limit) {
    return {
      admit: false,
      refusal: 'hard-spend-ceiling-reached',
      reason:
        `Dispatching would authorize up to ${usd(projected)} against a ${window} ceiling of ` +
        `${usd(limit)}: ${spent}, and this order authorizes a further ` +
        `${usd(order.ceilingUsd)}. ${WHO_RAISES_IT}`,
    };
  }

  return {
    admit: true,
    headroomUsd: headroom,
    reason:
      `${usd(headroom)} of headroom under the ${window} ceiling of ${usd(limit)} (${spent}); ` +
      `this order authorizes up to ${usd(order.ceilingUsd)}.`,
  };
}

// ---------------------------------------------------------------------------

/**
 * The spend figure, saying what kind of figure it is.
 *
 * Three shapes, because they are three different claims and #65 requires the
 * estimated part be labelled distinctly from the measured part: a clean
 * measurement, a measurement plus an upper-bound estimate, and a figure that
 * is only a floor because some runs cannot be bounded at all.
 */
function describeSpend(tally: SpendTally): string {
  const parts: string[] = [];

  if (tally.estimatedUsd > 0) {
    // `runsWithoutCost` minus `unboundedRuns`, not `runsWithoutCost`. Only the
    // difference actually contributed to `estimatedUsd`; attributing the whole
    // unreported count to it would spread the estimate across runs that
    // contributed nothing, and understate the per-run figure by exactly the
    // amount that is unknown. Found by running this against real rows, where
    // two unreported runs -- one with a ceiling, one without -- produced
    // "$5.00 estimated from the ceilings of 2 run(s)".
    const estimatedFrom = tally.runsWithoutCost - tally.unboundedRuns;
    parts.push(
      `spent at most ${usd(tally.totalUsd)} (${usd(tally.reportedUsd)} reported, ` +
        `${usd(tally.estimatedUsd)} estimated from the ceilings of ${estimatedFrom} ` +
        `run(s) that reported nothing)`,
    );
  } else {
    parts.push(`spent ${usd(tally.totalUsd)} reported`);
  }

  if (tally.unboundedRuns > 0) {
    // The one thing that must never be silent. A floor read as a total is how
    // a ceiling gets passed without anything appearing to go wrong.
    parts.push(
      `and an unknown amount across ${tally.unboundedRuns} run(s) with neither a reported ` +
        `cost nor a ceiling — so this figure is a floor, not a total`,
    );
  }

  return parts.join(' ');
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
