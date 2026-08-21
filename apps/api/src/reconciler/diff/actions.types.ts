import type { IssueIntent } from '../projection/desired-state.types';

/**
 * Everything the reconciler could decide to do.
 *
 * A closed union rather than free strings, so the executor that arrives in
 * Phase 4 must handle every case or fail to compile — and so #47's "every
 * action type has at least one test" is checkable rather than aspirational.
 */
export type ReconcileActionType =
  /** Hand a work order to a runner. Nothing in Phase 2 performs this. */
  | 'dispatch'
  /** Add a `factory/*` mirror label. */
  | 'add-mirror-label'
  /** Remove a `factory/*` mirror label that no longer reflects reality. */
  | 'remove-mirror-label'
  /** Tell a human. VISION §9: escalation is an action, not telemetry. */
  | 'escalate'
  /** Stop acting and require a human (VISION §8). */
  | 'quarantine'
  /** Release a quarantine a human has cleared. */
  | 'release-quarantine'
  /** Stop acting because a human applied `factory:hold`. */
  | 'hold';

/**
 * One thing the reconciler decided to do, as DATA.
 *
 * #47 is explicit that actions are data and not closures: an action must be
 * inspectable and serializable so the same list can be logged, diffed across
 * ticks, and later handed to an executor unchanged. A closure can be executed
 * but not reviewed, and review is the entire deliverable of the observation
 * week.
 */
export interface ReconcileAction {
  type: ReconcileActionType;
  /** `owner/name`. */
  repository: string;
  issueNumber: number;

  /**
   * Why this action was chosen, naming the specific observed inputs.
   *
   * #47: "The reason is not a log message. It is the deliverable of the
   * observation week." Reviewing *"dispatch #312 because it carries
   * factory:ready, has no open run, and is under budget"* is what validates
   * the logic; *"dispatch #312"* alone is not reviewable.
   *
   * The requirement is that a reviewer can reconstruct the decision from the
   * log entry ALONE, without reading code — which is why `evidence` below
   * carries the raw inputs rather than leaving them implied by the prose.
   */
  reason: string;

  /**
   * The observed facts that produced this action.
   *
   * Separate from `reason` because prose is for a human skimming and this is
   * for a human checking. A reason can be subtly wrong while sounding right;
   * the evidence is what makes that detectable.
   */
  evidence: ActionEvidence;

  /** The mirror label, for the two label action types. */
  label?: string;
}

export interface ActionEvidence {
  /** The intent the projection computed. */
  intent: IssueIntent;
  /** Input labels observed on the issue at the moment of the decision. */
  inputLabels: string[];
  /** The work order this concerns, if one exists. */
  workOrderIdentity: string | null;
  /** The live run's status, if there is a run. */
  runStatus: string | null;
  /** Mirror labels observed in GitHub before this tick's actions. */
  currentMirrorLabels: string[];
  /** Mirror labels the projection says should be present. */
  desiredMirrorLabels: string[];
}
