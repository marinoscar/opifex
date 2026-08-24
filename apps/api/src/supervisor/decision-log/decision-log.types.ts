import type { ActionClassId } from '../action-classes';

/**
 * What a proposal is about.
 *
 * A closed union at the boundary, a free string in the column — the shape
 * `WorkOrder.needs` already uses. `factory` covers a proposal with no single
 * subject: a daily brief is about the whole thing, and forcing it to name a
 * run would make the target field a lie for the sake of a NOT NULL.
 */
export type ProposalTargetKind = 'run' | 'work-order' | 'issue' | 'factory';

/**
 * One thing a proposer wants recorded.
 *
 * Note what is NOT here: no `execute`, no `apply`, no handle onto anything
 * that could act. A proposer's entire output is this object, and #90 requires
 * that be structural rather than conventional.
 */
export interface ProposalDraft {
  actionClass: ActionClassId;
  /**
   * Whether anything is being proposed.
   *
   * `declined` is a first-class outcome, not an absence. #90: "an action class
   * that is never proposed looks the same as one that is always proposed
   * correctly", and the approval rate #99 computes is biased unless the log
   * can tell those apart.
   */
  outcome: 'proposed' | 'declined';
  /** One line: what is proposed, or why nothing was. */
  summary: string;
  /**
   * The supervisor's reasoning, in its own words.
   *
   * A reviewer judges the ARGUMENT. An approval rate over proposals nobody
   * could read would measure agreement with a conclusion instead.
   */
  reasoning: string;
  targetKind?: ProposalTargetKind;
  /** A run uuid, a work order identity, an `owner/name#number`. */
  targetRef?: string;
  /** Class-specific structure. The proposer owns its shape. */
  details?: unknown;
}

/** How an invocation ended. Mirrors `SupervisorInvocationOutcome`. */
export type InvocationOutcome =
  'completed' | 'partial' | 'failed' | 'skipped_disabled' | 'skipped_quota';

/** Everything recorded about one scheduled invocation. */
export interface InvocationDraft {
  startedAt: Date;
  finishedAt: Date;
  outcome: InvocationOutcome;
  /** The model that was asked. `none` for an invocation that never ran. */
  model: string;
  /** The exact text handed to the model. Empty when nothing was rendered. */
  snapshotText: string;
  /** `SnapshotInput.generatedAt` — what every age in the text is relative to. */
  snapshotGeneratedAt?: Date;
  snapshotTruncated?: boolean;
  snapshotCharacters?: number;
  costUsd?: number | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  failureReason?: string | null;
}

/** A human's verdict. `pending` until somebody records one. */
export type ProposalReview = 'pending' | 'would_approve' | 'would_reject';

/** The per-class measurement the promotion ladder consumes (#99). */
export interface ActionClassApprovalRate {
  actionClass: string;
  /** Rows with outcome `proposed`. The denominator candidates. */
  proposed: number;
  /** Rows with outcome `declined`. Recorded so a silent class is visible. */
  declined: number;
  wouldApprove: number;
  wouldReject: number;
  /** Proposals nobody has judged. Not evidence in either direction. */
  pendingReview: number;
  /**
   * `wouldApprove / (wouldApprove + wouldReject)`, or null when nothing has
   * been reviewed.
   *
   * Null rather than zero, and the distinction is the whole point: a class
   * with no reviewed proposals has NO evidence, and rendering that as 0%
   * would read as a class that always proposes badly — the opposite
   * conclusion from the one the data supports.
   */
  approvalRate: number | null;
}
