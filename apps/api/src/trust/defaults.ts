/**
 * The four attributes VISION §8 attaches automatically, and their values.
 *
 * ## Why this function exists at all
 *
 * VISION §8's key move is not that grants CAN be scoped and capped — it is
 * that the one-tap path produces a scoped, capped grant without the operator
 * choosing anything:
 *
 * > Every approval offers **Approve / Deny / Always approve this class**. The
 * > third option silently attaches all four. Safe by construction, one tap.
 *
 * "Silently attaches all four" is a claim about code, not about a form. If
 * each caller of "Always approve this class" assembled its own expiry and its
 * own ceiling, the third tap would be safe wherever somebody remembered and
 * unbounded wherever they did not — and the unbounded one would be the one
 * written at 2am, because that is when the shortcut gets taken. One function,
 * one set of numbers, every path.
 *
 * ## Why these particular numbers
 *
 * Deliberately conservative, because the one-tap path is the path taken WHILE
 * ANNOYED. VISION §8 opens by saying operators "grant blanket trust out of
 * friction, not conviction" — so the whole design rests on the safe choice
 * also being the fast one. A default that needs a second thought to be safe
 * has already lost.
 *
 * ## Why these are constants in code and not configuration
 *
 * Not an oversight, and not a TODO. A configurable default for a SAFETY
 * attribute is how "14 days" becomes "3650 days" one afternoon: someone hits
 * the expiry once at a bad moment, widens the setting instead of renewing, and
 * the mechanism is gone with no diff, no review, and nothing in the audit
 * trail that says it used to be 14. Changing these should be a pull request
 * against this file, which is exactly the friction that keeps them honest.
 *
 * Note the asymmetry this creates and is meant to create: an operator who
 * genuinely wants a wider grant can still create one explicitly through
 * `TrustGrantService.create`, where the numbers they chose are recorded on the
 * row as their choice. What they cannot do is make the WIDE grant the one the
 * fast path hands out.
 */

/**
 * 14 days.
 *
 * Long enough to accumulate evidence — VISION §7's promotion ladder needs a
 * class to be exercised repeatedly before an approval rate means anything, and
 * a grant that dies in 48 hours produces a sample of two and a renewal prompt
 * nobody thanks you for.
 *
 * Short enough that a forgotten grant dies within a sprint. That is the real
 * constraint: VISION §8 says "silence revokes", and silence only revokes on a
 * horizon a human would notice. At 90 days the mechanism technically exists
 * and never fires in the life of the decision that created it.
 */
export const DEFAULT_GRANT_EXPIRY_DAYS = 14;

/**
 * $25 cumulative.
 *
 * The number is chosen against what one action costs, not against a monthly
 * budget: at a few dollars a run this is roughly a working week of autonomous
 * activity in one class in one repository. Enough that the grant does its job;
 * small enough that a grant behaving badly is a rounding error rather than an
 * incident. VISION §8: "the grant dies at a cumulative spend."
 */
export const DEFAULT_GRANT_BUDGET_CEILING_USD = 25;

/**
 * 0.34 — roughly one in three.
 *
 * Above chance-level noise for a class that mostly works, and well below the
 * rate at which a human would say "this is broken". Set at 0.5 the grant
 * survives a class that fails as often as it succeeds, which is not trust, it
 * is a coin. Set at 0.1 it dies on a bad afternoon and teaches the operator
 * that grants are flaky — and an operator who believes grants are flaky grants
 * blanket trust the next time, which is the failure VISION §8 exists to
 * prevent.
 *
 * Paired with `DEFAULT_GRANT_MIN_ACTIONS_BEFORE_AUTO_REVOKE`: a threshold on a
 * rate is meaningless without a sample size, and 1-of-1 is a 100% failure
 * rate.
 */
export const DEFAULT_GRANT_MAX_FAILURE_RATE = 0.34;

/**
 * $5 for a single action.
 *
 * A fifth of the default ceiling, so a runaway action is caught by this rule
 * several actions before the ceiling would have caught it. The two rules are
 * not redundant: the ceiling bounds the TOTAL damage, this bounds the RATE at
 * which damage arrives, and a single $25 action would pass the ceiling check
 * exactly once — after spending the whole grant.
 */
export const DEFAULT_GRANT_MAX_COST_PER_ACTION_USD = 5;

/**
 * 3 actions before either RATE rule may fire.
 *
 * The smallest sample on which "one in three failed" is a sentence rather than
 * an accident. This is the same sample-size argument #99 makes about PROMOTING
 * a class on too little evidence, applied to DEMOTING one — a grant that dies
 * on its first unlucky action is a grant that never survives long enough to
 * produce the evidence the ladder is asking for.
 *
 * It does NOT apply to the budget ceiling. See `evaluateAutoRevoke`.
 */
export const DEFAULT_GRANT_MIN_ACTIONS_BEFORE_AUTO_REVOKE = 3;

/**
 * 48 hours: when a grant starts being reported as "expiring soon".
 *
 * VISION §8 makes renewal "one tap", which presupposes the tap is offered
 * before the grant is already dead. Two days is long enough to cross a weekend
 * or a day off and short enough that the prompt is about THIS grant rather
 * than background noise. Consumed by #115's renewal prompt and by
 * `TrustGrantView.nearExpiry`.
 */
export const NEAR_EXPIRY_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * 20% headroom left: when a grant starts being reported as "near budget".
 *
 * A fraction rather than a dollar figure so a $25 grant and a $250 grant warn
 * at the same point in their own lives.
 */
export const NEAR_BUDGET_HEADROOM_FRACTION = 0.2;

/** The four attributes, as `CreateTrustGrantInput` needs them. */
export interface DefaultGrantAttributes {
  expiresAt: Date;
  budgetCeilingUsd: number;
  maxFailureRate: number;
  maxCostPerActionUsd: number;
  minActionsBeforeAutoRevoke: number;
}

/**
 * Everything a one-tap approval cannot supply, supplied.
 *
 * Takes `now` explicitly rather than reading the clock, for the reason every
 * other policy function in this codebase does (`run-deadline.ts`,
 * `budget-overrun.ts`): a function that reads the clock cannot be pinned to
 * its boundary in a test, and the boundary is the whole behaviour.
 */
export function defaultGrantAttributes(now: Date): DefaultGrantAttributes {
  return {
    expiresAt: new Date(
      now.getTime() + DEFAULT_GRANT_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    ),
    budgetCeilingUsd: DEFAULT_GRANT_BUDGET_CEILING_USD,
    maxFailureRate: DEFAULT_GRANT_MAX_FAILURE_RATE,
    maxCostPerActionUsd: DEFAULT_GRANT_MAX_COST_PER_ACTION_USD,
    minActionsBeforeAutoRevoke: DEFAULT_GRANT_MIN_ACTIONS_BEFORE_AUTO_REVOKE,
  };
}
