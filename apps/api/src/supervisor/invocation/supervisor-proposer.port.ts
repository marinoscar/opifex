import type { SnapshotInput } from '../snapshot/snapshot.types';
import type { ProposalDraft } from '../decision-log/decision-log.types';
import type { SupervisorModel } from './supervisor-model.port';

/** DI token for the proposer list. Multi-provider; may legitimately be empty. */
export const SUPERVISOR_PROPOSERS = Symbol('SUPERVISOR_PROPOSERS');

/** What a proposer is given at each invocation. */
export interface ProposerContext {
  /** The state, as plain values. */
  state: SnapshotInput;
  /** The rendered text, byte-identical to what is stored on the invocation. */
  snapshot: string;
  /** The model. A proposer that needs no model simply never calls it. */
  model: SupervisorModel;
}

/**
 * One advisory capability from VISION §7's right-hand column.
 *
 * ## The contract is: return drafts, change nothing
 *
 * A proposer's entire output is `ProposalDraft[]`. It is handed a snapshot and
 * a model that takes text and returns text, and it is given no repository, no
 * client, and no service that writes. #90 requires execution be structurally
 * impossible rather than merely unimplemented, and this signature is where
 * that is enforced for every proposer that will ever exist.
 *
 * ## Returning nothing is not the same as returning a decline
 *
 * A proposer that looked and had nothing to propose must return a draft with
 * `outcome: 'declined'`. An empty array means "this proposer did not run", and
 * the two are different facts: #90 needs the approval rate to distinguish a
 * class nobody proposes from a class always proposed correctly.
 */
export interface SupervisorProposer {
  /** The action class this proposer produces. One class per proposer. */
  readonly actionClass: string;
  /** For logs and for naming the proposer that failed. */
  readonly name: string;
  propose(context: ProposerContext): Promise<ProposalDraft[]>;
}
