/**
 * Plain-language headlines for the ways a decision can fail to land (#98).
 *
 * The API's own messages are full sentences that already name the moment and
 * the actor, and they are shown verbatim — #47's rule that a summarised reason
 * is one the operator cannot check. What they are not is SCANNABLE: a headline
 * is what an operator reads first on a phone, and "Somebody else answered this
 * first" versus "The clock answered it while you were deciding" is the whole
 * distinction the 409's `details.reason` exists to draw.
 */

import type { ApprovalConflictReason } from '../../types/approvals';

/** One short line naming which of the conflict cases this was. */
export function conflictHeadline(reason: ApprovalConflictReason): string {
  switch (reason) {
    case 'already-decided-by-human':
      return 'Somebody else answered this first. Their verdict stands.';
    case 'already-timed-out':
      return 'The clock answered it while you were deciding — its recorded timeout policy resolved it, and no human decided it.';
    case 'already-authorized-by-grant':
      return 'A standing trust grant already authorized this. It was never a question for a person.';
    case 'superseded':
      return 'The situation changed and the question stopped being worth asking. Nobody refused it.';
    case 'not-pending':
      return 'This request is no longer open, in a way the control plane cannot name. The row is inconsistent — worth reporting.';
  }
}

/**
 * What to tell the operator to do next, per conflict case.
 *
 * Separate from the headline because the ACTION differs even where the wording
 * of the cause looks similar: a timeout may be worth raising again, another
 * person's verdict is not.
 */
export function conflictNextStep(
  reason: ApprovalConflictReason,
): string | null {
  switch (reason) {
    case 'already-timed-out':
      return 'If the action is still wanted, it can be raised again.';
    case 'superseded':
      return 'If the action is still wanted, it can be raised again.';
    case 'already-decided-by-human':
    case 'already-authorized-by-grant':
    case 'not-pending':
      return null;
  }
}
