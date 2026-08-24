import type { TrustGrantEndReason, TrustGrantStatus } from '@prisma/client';

import type { ActionClassId } from '../supervisor/action-classes';

/**
 * The trust-grant service's vocabulary (#96, epic #22).
 *
 * VISION §8: "'Don't ask me anymore' never produces a permanent global grant.
 * Every grant carries four attributes, attached automatically" — scope,
 * expiry, a budget ceiling, and auto-revoke thresholds. The schema makes all
 * four NOT NULL; this file makes them all REQUIRED ARGUMENTS, so the shape a
 * caller has to construct is the same shape the database insists on. A create
 * input with optional ceilings would put the "safe by construction" claim one
 * forgotten field away from being false.
 */

/**
 * Everything needed to write a grant.
 *
 * No field here has a default. The defaults live in `defaults.ts`, applied by
 * the caller that has only a one-tap approval to work with — deliberately one
 * layer up, so this input is unambiguous about what was actually chosen. If
 * `create` filled blanks in itself, "the operator picked a $25 ceiling" and
 * "nobody picked anything" would be indistinguishable in the audit trail, and
 * VISION §8's whole point is that the grant's terms are legible after the
 * fact.
 */
export interface CreateTrustGrantInput {
  /** Scope, half one. Validated against the registry, per ADR-0011. */
  actionClass: ActionClassId;
  /**
   * Scope, half two. There is no "all repositories" value — VISION §8: "Never
   * 'trust the agent.'"
   */
  repositoryId: string;
  /** The human who authorized it. VISION §5's provenance edge. */
  grantedById: string;
  /** When it stops authorizing. Must be in the future. */
  expiresAt: Date;
  /** Cumulative spend at which the grant dies. Must be > 0. */
  budgetCeilingUsd: number;
  /** Auto-revoke threshold, in [0, 1]. */
  maxFailureRate: number;
  /** Auto-revoke threshold, in USD. Must be > 0. */
  maxCostPerActionUsd: number;
  /**
   * Sample-size floor for the two RATE-based auto-revoke rules. Optional
   * because the column has a defensible default (3) and a caller should be
   * able to accept it rather than be forced to restate it.
   */
  minActionsBeforeAutoRevoke?: number;
  /** The proposal whose approval created this grant, if there was one. */
  grantedFromProposalId?: string | null;
  /** The grant this one renews, if any — #115's renewal chain. */
  renewedFromId?: string | null;
  /** Free text from the granting human: why this scope, why this ceiling. */
  note?: string | null;
}

/**
 * A grant as a read model renders it.
 *
 * `Decimal` becomes `number` and `Date` becomes an ISO string here, matching
 * `ProposalView` in the decision log — a view type that still carries Prisma
 * types is a view type that leaks the ORM into the HTTP layer.
 *
 * The derived fields are computed once, here, rather than in each consumer.
 * #101 and #98 both need "how close is this to dying", and two independently
 * written versions of `remaining / ceiling` is exactly how a renewal banner
 * and a budget bar end up disagreeing on screen.
 */
export interface TrustGrantView {
  id: string;

  // Scope
  actionClass: string;
  repositoryId: string;

  // Expiry
  expiresAt: string;

  // Budget
  budgetCeilingUsd: number;
  spentUsd: number;
  actionsAuthorized: number;
  actionsFailed: number;

  // Auto-revoke thresholds
  maxFailureRate: number;
  maxCostPerActionUsd: number;
  minActionsBeforeAutoRevoke: number;

  // Lifecycle
  status: TrustGrantStatus;
  endedAt: string | null;
  endReason: TrustGrantEndReason | null;
  endDetail: string | null;
  /** Who revoked it, when a human did. Null for any other end. */
  revokedById: string | null;

  // Provenance
  note: string | null;
  grantedById: string;
  grantedFromProposalId: string | null;
  renewedFromId: string | null;
  createdAt: string;
  updatedAt: string;

  // --- Derived, relative to the moment of the read ------------------------

  /** `budgetCeilingUsd - spentUsd`, floored at zero. */
  remainingBudgetUsd: number;
  /**
   * `remainingBudgetUsd / budgetCeilingUsd`, in [0, 1]. The fraction, not the
   * dollars, is what makes a $25 grant and a $250 grant comparable on one
   * screen.
   */
  budgetHeadroomFraction: number;
  /**
   * Milliseconds until `expiresAt`. NEGATIVE once it has lapsed, deliberately
   * not clamped: "expired 3 hours ago" and "expires in 0ms" are different
   * facts, and #115's renewal prompt needs to tell them apart.
   */
  msUntilExpiry: number;
  /**
   * `actionsFailed / actionsAuthorized`, or NULL when nothing has been
   * authorized yet.
   *
   * Null rather than 0, for the same reason `approvalRates` reports null for
   * an unreviewed class: 0/0 is "no evidence", and rendering it as a 0%
   * failure rate says the opposite of what the data supports.
   */
  failureRate: number | null;
  /** Inside the renewal-prompt window (#115). See `defaults.ts`. */
  nearExpiry: boolean;
  /** Budget headroom below the warning fraction. See `defaults.ts`. */
  nearBudget: boolean;
}

/**
 * Why an authorization was refused.
 *
 * Six values, not one boolean, because #96's third acceptance criterion turns
 * on the operator being able to tell two of them apart. `no-grant` and
 * `expired` are the same OUTCOME and completely different DIAGNOSES: the first
 * means nobody ever granted this, the second means somebody did and let it
 * lapse. VISION §8's "silence revokes" only reads as deliberate if the system
 * can say which one happened — collapsed into one reason, a lapsed grant looks
 * to the operator exactly like a grant that was never made, and the mechanism
 * looks like a bug.
 */
export type AuthorizationDenial =
  /** Nothing covers this scope. */
  | 'no-grant'
  /** A grant exists for this scope but its expiry has passed. */
  | 'expired'
  /** A human ended it. */
  | 'revoked'
  /** The system ended it on evidence. */
  | 'suspended'
  /** The projected spend would cross the ceiling. */
  | 'budget-exhausted'
  /** `autonomyEligible === false` in the registry — or the class is unknown. */
  | 'class-ineligible';

/**
 * The answer to "may this run without asking?"
 *
 * A discriminated union rather than a nullable grant, so a caller cannot read
 * `result.grant` on a refusal and cannot forget to check. Every refusal
 * carries a `detail` NAMING THE OBSERVED NUMBERS — #47's house rule, "the
 * reason is not a log message": the sentence is what a human reads on the
 * daily digest, and a refusal a human cannot evaluate is indistinguishable
 * from an arbitrary one.
 */
export type AuthorizationResult =
  | { authorized: true; grant: TrustGrantView }
  | { authorized: false; reason: AuthorizationDenial; detail: string };

/**
 * The two rows a renewal produces (#115).
 *
 * BOTH are returned, not just the new one, because a renewal is a CHAIN and
 * the operator who tapped the button needs to see that the old grant actually
 * stopped. A response carrying only the successor would be indistinguishable
 * from "a second grant was created alongside the first", which is a completely
 * different and much worse state to be in — two live grants for the same scope
 * with two independent budget ceilings.
 */
export interface RenewTrustGrantResult {
  /** The new grant. Fresh attributes, narrowed by the old grant's own. */
  renewed: TrustGrantView;
  /**
   * The old grant, as it now stands: ended, `superseded_by_renewal`.
   *
   * Its `endDetail` names the successor, so the chain reads forwards from the
   * grant that ended as well as backwards from `renewedFromId`.
   */
  ended: TrustGrantView;
}

/** What one authorized action cost, and whether it worked. */
export interface UsageRecord {
  /** Actual spend attributable to the action. Must be finite and >= 0. */
  costUsd: number;
  /** Whether the action failed. The numerator of the failure rate. */
  failed: boolean;
}

/** The outcome of charging an action against a grant. */
export interface RecordUsageResult {
  /** The grant after the charge. */
  grant: TrustGrantView;
  /** Whether this charge tripped an auto-revoke rule. */
  suspended: boolean;
  /** Which rule, when one tripped. */
  reason: TrustGrantEndReason | null;
  /** The sentence the operator reads. Names the numbers that tripped it. */
  detail: string | null;
}

/** Filters for the grant list. Ended grants stay auditable — #96. */
export interface ListTrustGrantsQuery {
  repositoryId?: string;
  actionClass?: string;
  status?: TrustGrantStatus;
  /**
   * Include revoked, expired and suspended grants.
   *
   * Defaults to false because the common read is "what may run unattended
   * right now". #96's last acceptance criterion is that ended grants remain
   * listable, which is why this is a flag and not a hard filter: the history
   * of what was trusted and why it stopped being trusted is the evidence the
   * promotion ladder (#99) is judged on.
   */
  includeEnded?: boolean;
}
