/**
 * The trust-grant and promotion-ladder contract, as the cockpit reads it
 * (#101, epic #22, VISION §7 and §8).
 *
 * Like `types/approvals.ts` and unlike `types/cockpit.ts`, nothing here is a
 * proposal: every field is a projection of a zod schema `apps/api` already
 * serves and tests — `apps/api/src/trust/dto/trust-grant.dto.ts` and
 * `apps/api/src/promotion/dto/promotion.dto.ts`. When those change, this
 * changes with them.
 *
 * Four comments survive the trip because they are the four things a UI gets
 * WRONG, each in a direction that reverses the operator's conclusion:
 *
 *  1. `msUntilExpiry` is SIGNED. It goes negative once a grant has lapsed and
 *     is deliberately not clamped, because "expired 3 hours ago" and "expires
 *     in 0ms" are different facts. A component that formats it as a duration
 *     without checking the sign renders a lapsed grant as a live one.
 *  2. `failureRate` is NULL when nothing has been authorized. Null is "no
 *     evidence"; `0` is "actions ran and all of them succeeded". Rendering the
 *     first as the second tells the operator the grant is behaving perfectly
 *     when in fact it has never been used.
 *  3. `rate` on `ClassEvidence` is null for exactly the same reason, and the
 *     stakes are higher: a 0% APPROVAL rate says humans reject this class
 *     every single time they see it.
 *  4. `requirement` is the policy layer's own sentence and is rendered
 *     VERBATIM. It is never parsed, never recomputed from `thresholds`, and
 *     never appended to — a second implementation of the promotion rule in
 *     this app is a screen that states a requirement no longer in force the
 *     day a threshold is tuned.
 */

// ---------------------------------------------------------------------------
// Trust grants
// ---------------------------------------------------------------------------

/** Every status a grant row can hold. Also the `status` filter's values. */
export type TrustGrantStatus = 'active' | 'expired' | 'revoked' | 'suspended';

export const TRUST_GRANT_STATUSES: readonly TrustGrantStatus[] = [
  'active',
  'expired',
  'revoked',
  'suspended',
];

/**
 * WHY a grant ended, as a category.
 *
 * Never inferred from `status`: "suspended because the failure rate crossed
 * 34%" and "suspended because the class was demoted off the ladder" are
 * completely different facts about the factory, and only this separates them.
 */
export type TrustGrantEndReason =
  | 'manual_revocation'
  | 'expired'
  | 'budget_exhausted'
  | 'failure_rate_exceeded'
  | 'cost_per_action_exceeded'
  | 'class_demoted'
  | 'superseded_by_renewal';

/** A grant, as every read renders it. All four VISION §8 attributes, always. */
export interface TrustGrant {
  id: string;

  // -- Attribute 1: scope. Action class x repository, never "the agent". ----
  actionClass: string;
  repositoryId: string;

  // -- Attribute 2: expiry. ------------------------------------------------
  expiresAt: string;

  // -- Attribute 3: budget ceiling, and the spend measured against it. -----
  budgetCeilingUsd: number;
  spentUsd: number;
  actionsAuthorized: number;
  actionsFailed: number;

  // -- Attribute 4: auto-revoke thresholds. --------------------------------
  maxFailureRate: number;
  maxCostPerActionUsd: number;
  /**
   * Sample-size floor below which neither RATE rule may fire. Read together
   * with `failureRate`: a grant at 100% failure over one action has tripped
   * NOTHING, and a screen showing the rate without this number makes the
   * mechanism look broken.
   */
  minActionsBeforeAutoRevoke: number;

  // -- Lifecycle -----------------------------------------------------------
  status: TrustGrantStatus;
  endedAt: string | null;
  endReason: TrustGrantEndReason | null;
  /** The sentence naming the numbers that ended it. SHOW IT. */
  endDetail: string | null;
  /** Who revoked it, when a human did. Null for every other end. */
  revokedById: string | null;

  // -- Provenance ----------------------------------------------------------
  note: string | null;
  grantedById: string;
  grantedFromProposalId: string | null;
  /** The grant this one renews. The renewal chain's BACKWARD edge. */
  renewedFromId: string | null;
  createdAt: string;
  updatedAt: string;

  // -- Derived, relative to the moment of the read -------------------------
  remainingBudgetUsd: number;
  /** Headroom as a fraction in [0, 1]. Comparable across ceilings. */
  budgetHeadroomFraction: number;
  /** SIGNED. Negative once lapsed, and deliberately not clamped. */
  msUntilExpiry: number;
  /** NULL means no actions yet. NEVER render it as 0%. */
  failureRate: number | null;
  /** Inside the renewal-prompt window. Computed server-side on purpose. */
  nearExpiry: boolean;
  /** Headroom below the warning fraction. Computed server-side on purpose. */
  nearBudget: boolean;
}

/**
 * One row of the list: a grant plus the one class fact a list needs.
 *
 * `actionClassTitle` is null — never the raw id — for a class the ADR-0011
 * registry does not recognise, so registry drift stays visible to anything
 * reading the API. The cockpit renders `actionClassTitle ?? actionClass`.
 */
export interface TrustGrantListItem extends TrustGrant {
  actionClassTitle: string | null;
}

/** The ADR-0011 registry entry for the class a grant covers. */
export interface GrantActionClassEntry {
  id: string;
  title: string;
  /** What an action of this class does — a sentence, not a category label. */
  definition: string;
  effect: string;
  reversibility: 'reversible' | 'reversible-with-effort' | 'irreversible';
  /**
   * Whether this class may EVER hold a grant. Always true at creation time,
   * and reported anyway because the registry can be edited AFTER the fact — a
   * live grant for a now-ineligible class is exactly the drift worth seeing.
   */
  autonomyEligible: boolean;
  hasProposer: boolean;
  spendsMoney: boolean;
}

/** A renewal edge, FORWARD: a grant created to replace this one. */
export interface TrustGrantRenewalLink {
  id: string;
  status: TrustGrantStatus;
  expiresAt: string;
  createdAt: string;
}

export interface TrustGrantDetail extends TrustGrant {
  actionClassEntry: GrantActionClassEntry | null;
  /**
   * Grants issued to replace THIS one, newest first.
   *
   * The forward half of what `renewedFromId` records backwards. Both halves
   * are needed on one screen: an expired grant WITH a renewal was kept alive,
   * an expired grant WITHOUT one is "silence revokes" having happened — and
   * the backward edge alone cannot tell them apart.
   */
  renewedBy: TrustGrantRenewalLink[];
}

/** The filters `GET /trust/grants` honours. */
export interface TrustGrantFilters {
  repositoryId?: string;
  actionClass?: string;
  /** Exactly one status. OVERRIDES `includeEnded` server-side. */
  status?: TrustGrantStatus;
  /** Defaults to false: the common read is "what may run unattended now". */
  includeEnded?: boolean;
}

// ---------------------------------------------------------------------------
// The promotion ladder (VISION §7)
// ---------------------------------------------------------------------------

/**
 * The rung.
 *
 * `promoted` does NOT mean anything is running unattended — the ladder never
 * mints grants. A promoted class with no grant runs nothing.
 */
export type PromotionRung = 'observe' | 'measure' | 'promoted';

export type PromotionChangeReason =
  | 'promoted_on_evidence'
  | 'demoted_on_regression'
  | 'demoted_ineligible'
  | 'demoted_manually'
  | 'paused_globally';

/** The counts a rung decision is made from. */
export interface ClassEvidence {
  actionClass: string;
  approved: number;
  rejected: number;
  /** `approved + rejected`. The promotion denominator. */
  sample: number;
  /** `approved / sample`, or NULL at `sample === 0`. NEVER coalesce to 0. */
  rate: number | null;

  recentApproved: number;
  recentRejected: number;
  recentSample: number;
  recentRate: number | null;

  /**
   * How the sample splits across its two sources. Worth showing: a class
   * promoted entirely on review-queue judgements has never actually been asked
   * for in production, and the rate alone hides that.
   */
  fromProposals: number;
  fromApprovals: number;
}

export interface PromotionThresholds {
  minSample: number;
  promotionRate: number;
  demotionRate: number;
  demotionMinSample: number;
  regressionWindowDays: number;
}

export interface PromotionState {
  actionClass: string;
  /** ADR-0011 registry title, or NULL — never the raw id. */
  actionClassTitle: string | null;
  rung: PromotionRung;
  /** False is PERMANENT, not a state to be waited out. */
  eligible: boolean;

  changedAt: string;
  changeReason: PromotionChangeReason | null;
  changeDetail: string | null;

  /**
   * Evidence FROZEN at the last rung change. Never refreshed — evidence that
   * moves cannot be checked against the decision it justified.
   */
  evidence: ClassEvidence | null;
  /** The same counts as they stand NOW. What `requirement` is computed from. */
  currentEvidence: ClassEvidence;

  /** RENDERED VERBATIM. Never parsed, recomputed or appended to. */
  requirement: string;
  /**
   * What the NEXT evaluation would do. A FORECAST — when `enabled` is false
   * nothing will act on it, and a class sitting at `promote` while the ladder
   * is switched off is the single most important thing this endpoint says.
   */
  wouldChange: 'promote' | 'demote' | null;

  promotedAt: string | null;
  demotedAt: string | null;
  /**
   * How many times this class has EVER been demoted. A class that oscillates
   * is evidence about the THRESHOLDS rather than about the class.
   */
  demotionCount: number;
}

export interface PromotionLadder {
  /**
   * `PROMOTION_LADDER_ENABLED`. DEFAULTS OFF, so false is the common case —
   * and a screen full of rungs that does not say so reads as a set of live
   * conclusions when in fact nothing has moved or will.
   */
  enabled: boolean;
  readAt: string;
  thresholds: PromotionThresholds;
  states: PromotionState[];
}

export interface PromotionStateDetail {
  enabled: boolean;
  readAt: string;
  thresholds: PromotionThresholds;
  state: PromotionState;
}

export interface ManualDemotionResult {
  state: PromotionState;
  /** Active grants suspended. THE DURABLE EFFECT — nothing re-creates one. */
  grantsSuspended: number;
  /** Whether any transport accepted the notification. False is a real result. */
  notified: boolean;
  /**
   * Whether the next evaluation would put the class straight back on the
   * promoted rung. TRUE is the COMMON case, and it must be shown: the
   * suspended grants stay suspended, but the rung will read `promoted` again,
   * and an operator not told this concludes the button did nothing.
   */
  rungMayBeRestoredByLadder: boolean;
}
