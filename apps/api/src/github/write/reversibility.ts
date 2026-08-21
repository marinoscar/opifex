/**
 * The reversibility classification every GitHub write carries.
 *
 * VISION §3.5: **gate on reversibility, not importance.** Approval fatigue
 * comes from gating things that are *significant* rather than things that are
 * *hard to undo*; sorting by reversibility "reduces interruption volume by
 * roughly an order of magnitude without reducing safety."
 *
 * This is established here, at the adapter, rather than retrofitted when the
 * approval engine (#97, epic #22) arrives. Retrofitting means one pass over
 * every write in the system, made by whoever happens to be writing the
 * approval engine — and a write whose classification is guessed is worse than
 * one that was never classified, because the guess looks authoritative.
 *
 * The timeout policy VISION §8 attaches to each class is why the distinction
 * has teeth:
 *
 *  - reversible   → auto-approve on timeout, logged
 *  - irreversible → park and escalate, NEVER auto-approve
 *  - spends money → deny on timeout
 */
export enum Reversibility {
  /**
   * Fully undoable, leaving no trace anyone would see. Adding a label, then
   * removing it, returns the issue to where it was.
   */
  Reversible = 'reversible',

  /**
   * Technically undoable, but the undo is itself visible. A comment can be
   * deleted — after everyone subscribed to the issue has already been
   * emailed it. VISION's own examples of irreversible are "a force-push, a
   * merge, a Slack post, or money spent"; a comment is a post.
   */
  Irreversible = 'irreversible',
}

/**
 * Whether an action needs approval at all, independent of how reversible it is.
 *
 * ## The carve-out, and why it is not a loophole
 *
 * VISION §4 and §5 MANDATE that dispatch posts an authorization comment and
 * that every completed run posts its summary, unattended. VISION §3.5 gates
 * irreversible actions behind approval. A comment is irreversible. Both cannot
 * hold unless the comments the control plane is *required* to write are
 * classified as pre-authorized record-writing rather than approval-gated
 * actions.
 *
 * The carve-out is exactly those comment types, enumerated in
 * `RECORD_WRITING_ACTIONS`, and nothing else. It is not "comments are fine":
 * a comment the supervisor wants to post to argue for a decomposition is an
 * ordinary irreversible action and gets gated like one.
 *
 * The justification is that these writes carry no discretion. Their content is
 * determined by what already happened, they are the provenance chain VISION §5
 * exists to produce, and an operator asked to approve one is being asked to
 * approve the system recording what it just did.
 */
export enum ApprovalRequirement {
  /**
   * Goes through the approval engine, per its class's timeout policy.
   */
  Gated = 'gated',

  /**
   * Pre-authorized: control-plane record-writing that VISION mandates happen
   * unattended. Still logged, still appears in the §8 digest.
   */
  PreAuthorizedRecord = 'pre-authorized-record',
}

/**
 * Every write adapter, named.
 *
 * A closed enum rather than free strings, so `WRITE_ACTIONS` below can be
 * exhaustive over it — a new adapter that forgets to declare its
 * classification fails to compile rather than defaulting to something.
 */
export enum WriteAction {
  AddLabel = 'label.add',
  RemoveLabel = 'label.remove',
  /** The VISION §4 authorization record: the work order as fenced JSON. */
  PostAuthorizationRecord = 'comment.authorization-record',
  /** The VISION §5 run summary: runner, cost, duration, attempts, why it stopped. */
  PostRunSummary = 'comment.run-summary',
  /** An escalation note on the issue, so the record shows a human was told. */
  PostEscalationNote = 'comment.escalation-note',
  /** Any other comment — a supervisor proposal, an explanation. */
  PostComment = 'comment.general',
  /** Creating an issue. Gated further by the dedupe/template check (#108). */
  CreateIssue = 'issue.create',
}

export interface WriteActionDescriptor {
  action: WriteAction;
  reversibility: Reversibility;
  approval: ApprovalRequirement;
  /** One line for the approval prompt and the digest. */
  summary: string;
}

/**
 * The classification table.
 *
 * `Record<WriteAction, …>` makes a missing entry a compile error, which is the
 * point: this table is what the approval engine will consume, and an adapter
 * missing from it would be an action nobody ever decided about.
 */
export const WRITE_ACTIONS: Record<WriteAction, WriteActionDescriptor> = {
  [WriteAction.AddLabel]: {
    action: WriteAction.AddLabel,
    reversibility: Reversibility.Reversible,
    approval: ApprovalRequirement.Gated,
    summary: 'Add a label to an issue',
  },
  [WriteAction.RemoveLabel]: {
    action: WriteAction.RemoveLabel,
    reversibility: Reversibility.Reversible,
    approval: ApprovalRequirement.Gated,
    summary: 'Remove a label from an issue',
  },
  [WriteAction.PostAuthorizationRecord]: {
    action: WriteAction.PostAuthorizationRecord,
    reversibility: Reversibility.Irreversible,
    // Mandated by VISION §4: dispatch posts this, unattended.
    approval: ApprovalRequirement.PreAuthorizedRecord,
    summary: 'Post the work-order authorization record to its issue',
  },
  [WriteAction.PostRunSummary]: {
    action: WriteAction.PostRunSummary,
    reversibility: Reversibility.Irreversible,
    // Mandated by VISION §5: it is the join point between the human-readable
    // record and the telemetry store, and the gap it closes is the whole
    // reason it exists.
    approval: ApprovalRequirement.PreAuthorizedRecord,
    summary: 'Post the run summary to its pull request',
  },
  [WriteAction.PostEscalationNote]: {
    action: WriteAction.PostEscalationNote,
    reversibility: Reversibility.Irreversible,
    // VISION §9 makes escalation an action rather than telemetry. Gating the
    // note behind an approval would mean asking the human we are trying to
    // reach for permission to reach them.
    approval: ApprovalRequirement.PreAuthorizedRecord,
    summary: 'Record on the issue that an escalation was raised',
  },
  [WriteAction.PostComment]: {
    action: WriteAction.PostComment,
    reversibility: Reversibility.Irreversible,
    approval: ApprovalRequirement.Gated,
    summary: 'Post a comment',
  },
  [WriteAction.CreateIssue]: {
    action: WriteAction.CreateIssue,
    reversibility: Reversibility.Irreversible,
    approval: ApprovalRequirement.Gated,
    summary: 'Open a new issue',
  },
};

/** The pre-authorized carve-out, enumerated. Read by tests and the digest. */
export const RECORD_WRITING_ACTIONS: readonly WriteAction[] = Object.values(WRITE_ACTIONS)
  .filter((d) => d.approval === ApprovalRequirement.PreAuthorizedRecord)
  .map((d) => d.action);

/**
 * Operations that must never exist, from VISION §8's never-trustable list.
 *
 * Recorded as data purely so a test can assert no adapter implements one. The
 * enforcement is not this list — it is that there is no method to call.
 * An adapter that does not exist cannot be reached by a future mistake, by a
 * misconfigured trust grant, or by a supervisor that has talked itself into
 * something.
 *
 * VISION §8 singles out the last of these as mattering most: "An agent that
 * can edit the check enforcing its own trailers, or grant itself trust, has
 * the appearance of guardrails and none of the substance."
 */
export const NEVER_TRUSTABLE = [
  'force-push',
  'write to a protected branch',
  'delete a branch',
  'delete an issue',
  'delete a pull request',
  'merge a pull request',
  'read or write credentials',
  'modify CI workflows',
  'modify the policy table or budget configuration',
] as const;
