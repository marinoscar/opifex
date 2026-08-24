import type {
  ApprovalDecidedVia,
  ApprovalStatus,
  ApprovalTimeoutPolicy,
} from '@prisma/client';

import type { AutonomyEffect } from '../autonomy/never-trustable';
import type { NeverTrustableRefusal } from '../autonomy/never-trustable';
import type { ActionClassId } from '../supervisor/action-classes';
import type { TimeoutPolicy } from './timeout-policy';

/**
 * The approval gate's vocabulary (#97, epic #22, VISION §8, ADR-0014).
 *
 * The types here are the shape of the question VISION §8 asks — "may this
 * action proceed" — and of the three answers ADR-0013 and ADR-0014 between
 * them permit: refused outright, authorized by a standing grant, or handed to
 * a human with a stated consequence for silence.
 */

/**
 * Everything the gate needs to ask the question and to record it.
 *
 * VISION §8 sets the bar for what an approval must carry: "one tap from a
 * phone, with enough context to decide — what, why, blast radius, and what
 * happens if ignored." Three of those four are required fields here
 * (`summary`, `reasoning`, `blastRadius`); the fourth is not a field because
 * it is DERIVED — "what happens if ignored" is `timeoutPolicy`, resolved by
 * ADR-0014's total order rather than written by the caller. A caller that
 * could state its own consequence-for-silence would be a caller that could
 * state a convenient one.
 */
export interface RaiseApprovalInput {
  /** Validated against the ADR-0011 registry; an unknown id parks. */
  actionClass: ActionClassId;
  repositoryId: string;
  /**
   * Everything this action would do. REQUIRED, per ADR-0013.
   *
   * "An optional field is a field someone forgets, and 'someone forgot' is not
   * a security property." Derive it with `effectsFor`, never by hand: the
   * honesty of the declaration is a property of that one function, tested
   * once, rather than of every caller that will ever exist. It is also stored
   * on the row, so a historical approval is auditable against what the action
   * would actually have done rather than against the label it carried.
   */
  effects: AutonomyEffect[];
  /** WHAT is being asked, one line. */
  summary: string;
  /** WHY, in enough detail that a reviewer judges the argument. */
  reasoning: string;
  /** BLAST RADIUS: what else is affected. */
  blastRadius: string;
  /**
   * The action's estimated cost, if it has one.
   *
   * NULL MEANS UNKNOWN, NOT ZERO (VISION §6), and the gate treats the two
   * differently — see `ApprovalGateService.projectedCostFor`.
   */
  estimatedCostUsd?: number | null;
  /** The `SupervisorProposal` behind this, when there is one. */
  proposalId?: string | null;
  /** `run` | `work-order` | `issue` | `factory`. */
  targetKind?: string | null;
  /** The subject's stable identifier. Not a foreign key, by design. */
  targetRef?: string | null;
}

/**
 * The gate's answer.
 *
 * A discriminated union rather than a status plus optional fields, so a caller
 * cannot read `grantId` without having established there is one, and cannot
 * proceed on the strength of a field the compiler has not agreed exists. The
 * same argument `NeverTrustableVerdict` and `AuthorizationResult` both make.
 */
export type GateOutcome =
  /**
   * ADR-0013's rule 0. No `ApprovalRequest` row exists for this — see
   * `ApprovalGateService.gate` for why not.
   */
  | { outcome: 'refused'; refusals: NeverTrustableRefusal[] }
  /**
   * A standing grant covered it. `approvalId` is present and that is
   * DELIBERATE, not redundant.
   *
   * VISION §8: "Auto-approved actions still record what *would* have been
   * asked." That row is the record. #99's promotion ladder reads it to compute
   * an approval rate that excludes grant-authorized actions from the human
   * numerator, and #100's digest reads it to report "what ran under trust,
   * what it cost, what it changed". An action running under a grant with no
   * row is invisible autonomy — which is precisely what VISION §8's digest
   * exists to prevent, since "this is what makes the promotion ladder honest —
   * grants stay visible while they earn themselves."
   */
  | { outcome: 'authorized'; grantId: string; approvalId: string }
  /**
   * Nobody has answered yet. `timeoutAt` is null exactly when `timeoutPolicy`
   * is `park_and_escalate`, and that null is the never-auto-approve guarantee
   * (see `timeoutAtFor`).
   */
  | {
      outcome: 'pending';
      approvalId: string;
      timeoutPolicy: TimeoutPolicy;
      timeoutAt: Date | null;
    };

/** A human's verdict on one request. VISION §8's "one tap from a phone." */
export interface DecideApprovalInput {
  decision: 'approve' | 'deny';
  /** The person. Required — an approval with no approver is not evidence. */
  actorUserId: string;
  /** Free text. Optional: a fast verdict with no prose is still a verdict. */
  note?: string | null;
  /**
   * VISION §8's third option, "Always approve this class", which "silently
   * attaches all four" grant attributes.
   *
   * Only meaningful with `decision: 'approve'`, and only for an
   * autonomy-eligible class. Both of those cases are REPORTED in
   * `DecideResult.grantSkippedReason` rather than ignored — a flag that
   * silently does nothing is how an operator comes to believe they have a
   * grant they do not have, and then stops watching a class nobody promoted.
   *
   * ## RBAC composition, which this service cannot enforce
   *
   * Setting this true additionally requires `trust:grant`, which is
   * admin-only; `approvals:decide` alone is not enough. A contributor may
   * approve a single action and may NOT mint a grant from it. The service has
   * no view of permissions, so #98's controller must refuse the flag for a
   * caller without `trust:grant` rather than passing it through.
   */
  alwaysApproveThisClass?: boolean;
}

/** What happened when a human decided. */
export interface DecideResult {
  approval: ApprovalRequestView;
  /** The grant minted from "Always approve this class", if one was. */
  createdGrantId: string | null;
  /**
   * Why no grant was minted, when the flag was set and none was.
   *
   * Null when the flag was not set, or when a grant WAS minted. A sentence
   * rather than a boolean, for #47's house rule: the reason is what a human
   * reads, and "the flag was ignored" is not something anyone can act on.
   */
  grantSkippedReason: string | null;
  /**
   * True when this verdict landed after `timeoutAt` had already passed but
   * before the sweeper reached the row.
   *
   * #98's acceptance criterion is that "an approval arriving after its timeout
   * is handled unambiguously". The unambiguous handling is: the RECORDED state
   * is the authority, so a request still sitting at `pending` may still be
   * decided by a human and the decision counts as human evidence — and the
   * caller is told the window had lapsed so it can say so rather than leaving
   * the operator to wonder which of the two won. The race with the sweeper is
   * settled by a conditional update, so exactly one of them writes.
   */
  decidedAfterTimeout: boolean;
}

/** What one sweep did. Counts per outcome, per #97. */
export interface SweepTimeoutsResult {
  /** Rows the query returned as pending and due. */
  examined: number;
  /** Resolved to `auto_approved` by their RECORDED policy. */
  autoApproved: number;
  /** Resolved to `auto_denied` by their RECORDED policy. */
  autoDenied: number;
  /**
   * Rows skipped because their recorded policy was `park_and_escalate`.
   *
   * Structurally always zero — such a row has `timeoutAt === null` and cannot
   * be selected. Counted anyway so the defensive assertion has somewhere to
   * report to, and so a non-zero value here is loud rather than invisible.
   */
  skippedParked: number;
  /**
   * Rows another writer resolved between the query and the update.
   *
   * Normal, not an error: a human answering at the same moment the sweeper
   * runs is exactly the race the conditional update exists to settle, and the
   * human wins.
   */
  raced: number;
}

/** Filters for the human-facing queue. */
export interface ListPendingQuery {
  repositoryId?: string;
  actionClass?: string;
}

/**
 * Per-class approval evidence for #99's promotion ladder.
 *
 * ## Why the buckets are separate and not summed
 *
 * A TIMEOUT IS SILENCE, NOT AGREEMENT. Counting `auto_approved` as an approval
 * would let a class promote itself by being ignored: nobody is ever asked,
 * every request times out reversible, and the ladder reads a 100% approval
 * rate over a population of zero human opinions. That is the self-dealing
 * evidence problem VISION §7's "on evidence, never in bulk" exists to prevent,
 * and it is the single most important reason `ApprovalStatus` has four
 * decided values rather than two.
 *
 * The same argument runs the other way and is why `auto_denied` is excluded
 * too: silence is not disapproval either, and putting it in the DENOMINATOR
 * would depress a class's rate for the sin of being raised while its operator
 * slept.
 *
 * `grantAuthorized` is excluded on a related but distinct ground: it is not
 * silence, it is machine action taken on evidence a human supplied EARLIER.
 * Counting it as a fresh approval would let one grant's authorisations
 * re-attest to the trust that created them, which is a feedback loop, not
 * evidence. The `decidedVia` axis is what separates human evidence from
 * machine action; `status` deliberately does not encode it a second time.
 */
export interface ClassApprovalRates {
  actionClass: string;

  // --- Human evidence. #99's numerator and denominator, and nothing else. --
  /** `status: approved`, `decidedVia: human`. */
  approved: number;
  /** `status: denied`, `decidedVia: human`. */
  denied: number;
  /** `approved + denied`. The denominator. */
  humanDecisions: number;
  /**
   * `approved / humanDecisions`, or NULL when no human has decided one.
   *
   * Null rather than 0, matching `TrustGrantView.failureRate`: 0/0 is "no
   * evidence", and rendering it as a 0% approval rate says the opposite of
   * what the data supports — it would read as a class humans always reject.
   */
  approvalRate: number | null;

  // --- Everything else, counted separately and never folded in. -----------
  /** Resolved by the clock under an `auto_approve` policy. Not agreement. */
  autoApproved: number;
  /** Resolved by the clock under a `deny` policy. Not disapproval. */
  autoDenied: number;
  /** Ran under a standing grant, `decidedVia: grant`. */
  grantAuthorized: number;
  /** Still waiting on a human or the clock. */
  pending: number;
  /** Parked under `park_and_escalate`; waits indefinitely for a person. */
  parked: number;
  /** The world moved on before anyone had to answer. */
  superseded: number;
}

/**
 * An `ApprovalRequest` as a read model renders it.
 *
 * `Decimal` becomes `number | null` and `Date` becomes an ISO string, matching
 * `TrustGrantView` and `ProposalView`: a view type that still carries Prisma
 * types is a view type that leaks the ORM into the HTTP layer #98 will build.
 */
export interface ApprovalRequestView {
  id: string;
  actionClass: string;
  repositoryId: string;
  proposalId: string | null;
  targetKind: string | null;
  targetRef: string | null;

  summary: string;
  reasoning: string;
  blastRadius: string;
  /** As declared at raise time and frozen there (ADR-0013). */
  effects: AutonomyEffect[];
  /** Null means UNKNOWN, not zero (VISION §6). */
  estimatedCostUsd: number | null;

  timeoutPolicy: ApprovalTimeoutPolicy;
  /** Null exactly when `timeoutPolicy` is `park_and_escalate`. */
  timeoutAt: string | null;

  status: ApprovalStatus;
  decidedAt: string | null;
  decidedById: string | null;
  decidedVia: ApprovalDecidedVia | null;
  decisionNote: string | null;

  /** The grant that AUTHORIZED this. */
  grantId: string | null;
  /** The grant BORN from the decision on this. A different edge. */
  createdGrantId: string | null;
  escalationId: string | null;

  createdAt: string;
  updatedAt: string;
}
