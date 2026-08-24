/**
 * The approval contract, as the cockpit reads it (#98, epic #22, VISION §8).
 *
 * Unlike `types/cockpit.ts`, nothing here is a proposal: every field below is
 * a projection of a zod schema that `apps/api` already serves and tests —
 * `apps/api/src/approvals/dto/approval.dto.ts`. When that file changes, this
 * one changes with it, and the mismatch must surface at the parse boundary
 * (`services/api.ts`) rather than as a component rendering `undefined`.
 *
 * The comments that survive the trip are the ones the UI would otherwise get
 * WRONG. Three of them are load-bearing:
 *
 *  1. `timeoutAt` is null EXACTLY when `timeoutPolicy` is `park_and_escalate`,
 *     and that null is the never-auto-approve guarantee expressed as data. No
 *     countdown may be drawn for it — see `components/approvals/ifIgnored.ts`.
 *  2. `estimatedCostUsd: null` means UNKNOWN, never zero. It is rendered as
 *     "Unknown" and never as `$0.00`.
 *  3. `decidedVia` is the axis that separates human evidence from machine
 *     action. `status` deliberately does not encode it a second time.
 */

/** What happens when nobody answers. The RECORDED policy, never recomputed. */
export type ApprovalTimeoutPolicy =
  'auto_approve' | 'deny' | 'park_and_escalate';

export type ApprovalStatus =
  | 'pending'
  | 'parked'
  | 'approved'
  | 'denied'
  | 'auto_approved'
  | 'auto_denied'
  | 'superseded';

/** Who or what decided. `human` is evidence; `grant` and `timeout` are not. */
export type ApprovalDecidedVia = 'human' | 'timeout' | 'grant';

/**
 * The two statuses that mean "a human has not answered this yet".
 *
 * `parked` is NOT a resolution — it is `pending` with no timer — so the queue
 * shows both, and the filter can narrow between them but never widen to a
 * decided row (the API's enum refuses anything else).
 */
export const OPEN_APPROVAL_STATUSES = ['pending', 'parked'] as const;
export type OpenApprovalStatus = (typeof OPEN_APPROVAL_STATUSES)[number];

/**
 * One declared effect, frozen on the row at raise time (ADR-0013).
 *
 * Open-ended on purpose, mirroring the API's `catchall` schema: the column is
 * a frozen record of what a HISTORICAL action declared it would do, and a row
 * whose shape predates a widening of `AutonomyEffect` is still the truth about
 * that action. Only `kind` is guaranteed, and every consumer branches on it.
 */
export interface ApprovalEffect {
  kind: string;
  [field: string]: unknown;
}

/** An approval request, as the queue and the detail screen read it. */
export interface Approval {
  id: string;
  actionClass: string;
  repositoryId: string;
  proposalId: string | null;
  targetKind: string | null;
  targetRef: string | null;

  /** WHAT is being asked, one line (VISION §8). */
  summary: string;
  /** WHY, in enough detail that a reviewer can judge the argument. */
  reasoning: string;
  /** BLAST RADIUS: what else is affected. */
  blastRadius: string;
  /** Everything this action would do, frozen at raise time. */
  effects: ApprovalEffect[];
  /** NULL MEANS UNKNOWN, NOT ZERO (VISION §6). */
  estimatedCostUsd: number | null;

  timeoutPolicy: ApprovalTimeoutPolicy;
  /** Null exactly when `timeoutPolicy` is `park_and_escalate`. No countdown. */
  timeoutAt: string | null;

  status: ApprovalStatus;
  decidedAt: string | null;
  decidedById: string | null;
  decidedVia: ApprovalDecidedVia | null;
  decisionNote: string | null;

  /** The grant that AUTHORIZED this. */
  grantId: string | null;
  /** The grant BORN from the decision on this. A different edge entirely. */
  createdGrantId: string | null;
  /** Set only for a parked approval, which raises one (VISION §8). */
  escalationId: string | null;

  createdAt: string;
  updatedAt: string;
}

/**
 * One row of the QUEUE — an approval plus the one class fact triage needs.
 *
 * `GET /api/approvals` joins the ADR-0011 registry title onto every row, so
 * this app never keeps its own copy of the taxonomy to prettify a list. That
 * copy is exactly the drift ADR-0011 put the classes in one file to prevent,
 * which is why the fix went into the API rather than into a lookup table here.
 *
 * The title and NOTHING ELSE from the entry: `definition`, `reversibility` and
 * `autonomyEligible` answer "should this happen?", which is the detail
 * screen's question. A triage row only has to answer "which do I open first?".
 */
export interface ApprovalListItem extends Approval {
  /**
   * The registry title for `actionClass`, or NULL when the registry does not
   * know the id.
   *
   * The server never falls back to the raw id, deliberately: a title that
   * silently equalled its id would hide registry drift. Rendering is
   * `actionClassTitle ?? actionClass`, so the id still shows — the difference
   * is that the null is visible to anything reading the API.
   */
  actionClassTitle: string | null;
}

/**
 * The ADR-0011 registry entry for the class under question, joined onto the
 * detail response by the API.
 *
 * Null for a class the registry does not recognise, and that is a REAL case
 * rather than a defensive one: an unknown class parks, so a parked approval
 * with a null entry means the proposer and the registry have drifted — not
 * that an irreversible action awaits judgment (ADR-0014).
 */
export interface ActionClassEntry {
  id: string;
  /** Short human label. What the notification title says. */
  title: string;
  /** What a proposal of this class asks for — a sentence, not a label. */
  definition: string;
  /** What changes outside the control plane if a human approves. */
  effect: string;
  reversibility: 'reversible' | 'reversible-with-effort' | 'irreversible';
  /**
   * Whether this class may EVER be promoted to auto-execution.
   *
   * The one field "Always approve this class" turns on: the flag on an
   * ineligible class approves the single action and mints NO grant, and an
   * operator who is not told that comes to believe they hold a grant they do
   * not.
   */
  autonomyEligible: boolean;
  hasProposer: boolean;
  spendsMoney: boolean;
}

export interface ApprovalDetail extends Approval {
  actionClassEntry: ActionClassEntry | null;
}

/** The body `POST /approvals/:id/decide` accepts. */
export interface DecideApprovalInput {
  decision: 'approve' | 'deny';
  /** Free text, max 2000 chars. A fast verdict with no prose is still one. */
  note?: string;
  /** VISION §8's third option. Requires `trust:grant` as well as decide. */
  alwaysApproveThisClass?: boolean;
}

export interface DecideApprovalResult {
  approval: Approval;
  /** The grant minted from "Always approve this class", if one was. */
  createdGrantId: string | null;
  /**
   * Why no grant was minted when the flag was set and none was. SHOW IT — a
   * flag that quietly does nothing is the failure this field exists to
   * prevent.
   */
  grantSkippedReason: string | null;
  /** The verdict counted, but the window had already lapsed. Say so. */
  decidedAfterTimeout: boolean;
}

/**
 * Why a decision was refused with 409, as a stable id the cockpit branches on.
 *
 * `not-pending` is in the union because the API can emit it: it names a row
 * whose status and `decidedVia` are a combination the gate does not write.
 * Rare, but a UI that cannot render it would fall through to a generic error
 * for the one case that means the data is inconsistent.
 */
export type ApprovalConflictReason =
  | 'already-decided-by-human'
  | 'already-timed-out'
  | 'already-authorized-by-grant'
  | 'superseded'
  | 'not-pending';

/**
 * Per action class, how often a human approves it (`GET /approvals/rates`).
 *
 * The buckets are separate and must NEVER be summed: `autoApproved` is
 * SILENCE, not agreement, and folding it into `approved` would let a class
 * promote itself by being ignored. `approvalRate` is null — never 0 — when no
 * human has decided one, because 0/0 is "no evidence" and 0% says the
 * opposite.
 */
export interface ClassApprovalRates {
  actionClass: string;
  approved: number;
  denied: number;
  humanDecisions: number;
  approvalRate: number | null;
  autoApproved: number;
  autoDenied: number;
  grantAuthorized: number;
  pending: number;
  parked: number;
  superseded: number;
}
