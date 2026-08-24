import type { TrustGrantEndReason } from '@prisma/client';

/**
 * The self-revoking half of VISION §8.
 *
 * > **Auto-revoke** — failure rate or cost-per-PR crossing a threshold
 * > suspends the grant and explains why.
 *
 * A pure function, like `budget-overrun.ts` and `run-deadline.ts`, for the
 * reason VISION §3.6 gives: enforcement lives in deterministic policy, and
 * deterministic policy can be pinned to its boundary without a clock or a
 * database. Everything it needs is an argument.
 *
 * ## "and explains why" is a requirement, not a nicety
 *
 * Every verdict carries a `detail` that names the observed numbers. #96 says
 * why in one sentence: a grant that vanishes silently teaches the operator the
 * system is unpredictable, and an operator who believes the system is
 * unpredictable grants blanket trust the next time — which is precisely the
 * friction VISION §8 opens by warning about. `reason` is a category for the
 * query; `detail` is the sentence a human reads on the daily digest.
 */

/** Everything the three rules are computed from. */
export interface AutoRevokeInputs {
  spentUsd: number;
  budgetCeilingUsd: number;
  actionsAuthorized: number;
  actionsFailed: number;
  maxFailureRate: number;
  maxCostPerActionUsd: number;
  minActionsBeforeAutoRevoke: number;
  /**
   * Only used to decline to judge a grant that has already lapsed. See below.
   */
  expiresAt: Date;
}

/** A rule fired, with the sentence explaining it. */
export interface AutoRevokeVerdict {
  reason: TrustGrantEndReason;
  detail: string;
}

/**
 * Should this grant be suspended, and what would we tell the operator?
 *
 * `null` means "keep authorizing". The three rules are checked in the order
 * below and the FIRST match wins — a grant that has both blown its ceiling and
 * its failure rate is reported as budget-exhausted, because that is the
 * harder, more absolute fact and the one an operator acts on first.
 *
 * ## Why the sample-size guard covers two rules and not the third
 *
 * `minActionsBeforeAutoRevoke` gates the two RATE rules — failure rate and
 * average cost per action. A rate computed over one observation is not a rate:
 * a grant whose first action happens to fail has a 100% observed failure rate,
 * and auto-revoking on that would kill nearly every grant before it produced
 * any of the evidence #99's promotion ladder is asking for. Same argument #99
 * makes about promoting a class on too little evidence, pointed the other way.
 *
 * It does NOT gate `budget_exhausted`, on purpose. A ceiling is an ABSOLUTE,
 * not an estimate — it is a ceiling on the first action exactly as much as on
 * the tenth. VISION §8 says "the grant dies at a cumulative spend", with no
 * qualifier about how many actions produced it, and applying a sample-size
 * guard to it would mean a single action that spent the entire budget kept the
 * grant alive on the grounds that we had not seen enough of them.
 *
 * `now` is taken and used for one thing only: a grant whose expiry has already
 * passed is not judged here. It is already dead, `authorize` already refuses
 * it, and writing a `failure_rate_exceeded` reason onto it would overwrite the
 * true cause of death — `expired`, VISION §8's "silence revokes" — with a rate
 * breach that was never what stopped it. The audit trail is the product here.
 */
export function evaluateAutoRevoke(
  grant: AutoRevokeInputs,
  now: Date,
): AutoRevokeVerdict | null {
  if (grant.expiresAt.getTime() <= now.getTime()) return null;

  const {
    spentUsd,
    budgetCeilingUsd,
    actionsAuthorized,
    actionsFailed,
    maxFailureRate,
    maxCostPerActionUsd,
    minActionsBeforeAutoRevoke,
  } = grant;

  // Rule 1 — the ceiling. Absolute, ungated by sample size.
  //
  // `>=`, not `>`: reaching the ceiling exhausts the grant. A $25 ceiling
  // authorizes spending up to $25; it does not authorize the action that
  // starts from $25. Same rule the admission gate's tally check uses.
  if (spentUsd >= budgetCeilingUsd) {
    return {
      reason: 'budget_exhausted',
      detail:
        `Suspended: ${usd(spentUsd)} spent against a ${usd(budgetCeilingUsd)} ` +
        `budget ceiling across ${count(actionsAuthorized, 'authorized action')}. ` +
        'The grant is exhausted; a renewal issues a new ceiling.',
    };
  }

  const hasEnoughEvidence = actionsAuthorized >= minActionsBeforeAutoRevoke;

  // Rule 2 — the failure rate. Gated: see the note above.
  if (hasEnoughEvidence && actionsAuthorized > 0) {
    const failureRate = actionsFailed / actionsAuthorized;
    if (failureRate > maxFailureRate) {
      return {
        reason: 'failure_rate_exceeded',
        detail:
          `Suspended: ${actionsFailed} of ${actionsAuthorized} authorized ` +
          `actions failed (${percent(failureRate)}), above the ` +
          `${percent(maxFailureRate)} threshold set when the grant was created.`,
      };
    }
  }

  // Rule 3 — the average cost per action. Gated for the same reason: one
  // expensive action is an observation, not a trend. The ceiling above is what
  // stops a single runaway action from mattering while we wait for the third.
  if (hasEnoughEvidence && actionsAuthorized > 0) {
    const costPerAction = spentUsd / actionsAuthorized;
    if (costPerAction > maxCostPerActionUsd) {
      return {
        reason: 'cost_per_action_exceeded',
        detail:
          `Suspended: ${usd(costPerAction)} average cost across ` +
          `${count(actionsAuthorized, 'authorized action')} ` +
          `(${usd(spentUsd)} total), above the ${usd(maxCostPerActionUsd)} ` +
          'per-action threshold set when the grant was created.',
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}
