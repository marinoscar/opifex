/**
 * The steering wire shapes (#426), mirroring `apps/api/src/steering/dto/steering.dto.ts`.
 *
 * Hand-written rather than generated for the reason every other type in this
 * folder is: importing the API's zod module into `apps/web` would drag NestJS
 * into this TypeScript project, which is the coupling the two-app split
 * exists to prevent. What keeps them honest instead is
 * `__tests__/config/settingKeyDrift.test.ts`, which reads the API's own source
 * off disk and asserts that the label values and unresolved reasons named here
 * are the ones the API defines — a fixture is evidence about a fixture, and
 * only the API's source is evidence about the API (#417).
 *
 * ## Why `add` and `remove` stay two fields all the way to the screen
 *
 * The API carries them apart because removals are the destructive half, and
 * #425's DTO says so on the field itself. Folding them into one "operations"
 * list here — even one carrying a sign — would put the decision about how
 * prominent a removal is inside a rendering loop, which is exactly where it
 * gets lost.
 */

/** The only two labels steering may write. `STEERABLE_LABELS` in the API DTO. */
export type SteerableLabel = 'factory:ready' | 'factory:hold';

/** `unresolvedReasonSchema`. Every one is an outcome, never an error. */
export type UnresolvedReason =
  | 'issue-not-found'
  | 'issue-closed'
  | 'is-pull-request'
  | 'repository-not-registered'
  | 'ambiguous-repository'
  | 'unreadable'
  | 'needs-interpretation';

export interface UnresolvedReference {
  /** As the operator wrote it, or the resolved `owner/name#12`. */
  reference: string;
  reason: UnresolvedReason;
  /** One sentence an operator can act on. Rendered verbatim. */
  detail: string;
}

export interface SteeringOperation {
  /** `owner/name#123`. */
  ref: string;
  owner: string;
  name: string;
  number: number;
  title: string | null;
  add: SteerableLabel[];
  remove: SteerableLabel[];
  /**
   * The `factory:` labels observed at propose time — the drift baseline.
   *
   * Echoed back on apply exactly as received. The server re-reads the issue
   * and compares against this, so reshaping it (sorting it, filtering it to
   * the steerable two, dropping it because "the server knows") silently turns
   * drift detection off while everything still looks like it works.
   */
  observedInputLabels: string[];
  reason: string;
  /** True when the operator NAMED this issue; false when it is collateral. */
  named: boolean;
}

export interface SteeringBlastRadius {
  issuesAffected: number;
  named: number;
  collateral: number;
  labelsAdded: number;
  labelsRemoved: number;
  unreadied: number;
  readied: number;
  held: number;
  destructive: boolean;
  /** The API's own sentence. Rendered, never re-derived. */
  summary: string;
}

export interface SteeringModelReadiness {
  consumer: 'chat';
  provider: string;
  model: string;
  available: boolean;
  unavailableReason: string | null;
}

export interface SteeringSpendVerdict {
  admitted: boolean;
  reason: string;
}

export interface SteeringInterpretation {
  method: 'deterministic' | 'none';
  modelInvoked: boolean;
  notes: string[];
  ambiguity: string | null;
  /** Null on the deterministic path: the chat's settings were not consulted. */
  model: SteeringModelReadiness | null;
  /** Null on the deterministic path, for the same reason. */
  spend: SteeringSpendVerdict | null;
}

export interface SteeringEpicResolution {
  ref: string;
  title: string;
  source: string;
  maxDepth: number;
  childrenFound: number;
  nativeUnavailable: string | null;
}

export interface SteeringScope {
  intent: 'ready' | 'hold';
  exclusive: boolean;
  elseIntent: 'unready' | 'hold';
  repositories: string[];
  candidatesConsidered: number;
  epics: SteeringEpicResolution[];
}

export interface SteeringProposal {
  proposalId: string;
  proposedAt: string;
  /** `proposedAt` + 30 minutes. Apply answers 409 past it. */
  expiresAt: string;
  instruction: string;
  interpretation: SteeringInterpretation;
  scope: SteeringScope;
  operations: SteeringOperation[];
  blastRadius: SteeringBlastRadius;
  unresolved: UnresolvedReference[];
}

export interface ProposeSteeringInput {
  instruction: string;
  /** `owner/name`. Which repository a bare `#12` means. */
  repository?: string;
  maxDepth?: number;
}

/**
 * One operation as apply takes it back.
 *
 * A subset of `SteeringOperation`, and deliberately not the whole thing: the
 * API's `applySteeringOperationSchema` accepts these six fields, and sending
 * `ref`/`title`/`named` back would be sending a rendering concern to a writer.
 */
export interface ApplySteeringOperation {
  owner: string;
  name: string;
  number: number;
  add: SteerableLabel[];
  remove: SteerableLabel[];
  observedInputLabels: string[];
}

export interface ApplySteeringInput {
  proposalId: string;
  proposedAt: string;
  instruction: string;
  operations: ApplySteeringOperation[];
}

/** `skippedReasonSchema`. `drift` is the one with a payload. */
export type SkippedReason =
  | 'drift'
  | 'issue-not-found'
  | 'issue-closed'
  | 'is-pull-request'
  | 'repository-not-registered';

export interface LabelDrift {
  label: string;
  /** Present when the proposal was made. */
  wasPresent: boolean;
  /** Present now. */
  isPresent: boolean;
}

export interface AppliedLabelWrite {
  label: SteerableLabel;
  operation: 'add' | 'remove';
  /** False when `github.writesEnabled` suppressed it. */
  performed: boolean;
  /** True when the desired state already held. */
  noop: boolean;
}

export interface AppliedOperation {
  ref: string;
  add: SteerableLabel[];
  remove: SteerableLabel[];
  writes: AppliedLabelWrite[];
}

export interface SkippedOperation {
  ref: string;
  reason: SkippedReason;
  detail: string;
  /** Non-empty only for `drift`. */
  drift: LabelDrift[];
}

export interface SteeringApplyResult {
  proposalId: string;
  applied: AppliedOperation[];
  skipped: SkippedOperation[];
  /** Whether any label actually reached GitHub. */
  labelWritten: boolean;
  /** The kill switch as it stood for this call. */
  writesEnabled: boolean;
  /** Always false. Reconciliation is a later tick's job. */
  reconciled: boolean;
  effect: string;
  summary: {
    operationsRequested: number;
    operationsApplied: number;
    operationsSkipped: number;
    labelWrites: number;
    labelWritesPerformed: number;
  };
}
