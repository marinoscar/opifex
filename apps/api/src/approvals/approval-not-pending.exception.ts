import { ConflictException } from '@nestjs/common';
import type { ApprovalStatus, ApprovalDecidedVia } from '@prisma/client';

/**
 * Why a request could not be decided, as a stable machine-readable id.
 *
 * #98's acceptance criterion is that "an approval arriving after its timeout is
 * handled unambiguously", and a bare 409 does not do that: "somebody already
 * answered this" and "the clock answered it while you were typing" call for
 * completely different things from the operator. The first means their view is
 * stale and someone else has it; the second means the action was denied by
 * silence and they may want to raise it again. One status code cannot say
 * which.
 *
 * These ids are stable because the cockpit branches on them. `HttpExceptionFilter`
 * overwrites the envelope's `code` from the status code, so the discriminator
 * travels in `details.reason`, which the filter passes through untouched.
 */
export type ApprovalNotPendingReason =
  /** A person already recorded a verdict. `decidedById` names them. */
  | 'already-decided-by-human'
  /** The timeout window lapsed and the sweeper resolved it. */
  | 'already-timed-out'
  /** A standing grant authorized it; it was never a human-facing question. */
  | 'already-authorized-by-grant'
  /** The world moved on and the question stopped being worth asking. */
  | 'superseded'
  /** Resolved, but by none of the above — a state that should not exist. */
  | 'not-pending';

/**
 * A 409 that says which of the four ways this request was already resolved.
 *
 * The message names the moment and, where there is one, the actor — #47's
 * house rule that a reason a human cannot evaluate is indistinguishable from
 * an arbitrary one.
 */
export class ApprovalNotPendingException extends ConflictException {
  constructor(
    readonly reason: ApprovalNotPendingReason,
    message: string,
    details: {
      approvalId: string;
      status: ApprovalStatus;
      decidedVia: ApprovalDecidedVia | null;
      decidedAt: Date | null;
      decidedById: string | null;
    },
  ) {
    super({
      code: 'APPROVAL_NOT_PENDING',
      message,
      details: {
        reason,
        approvalId: details.approvalId,
        status: details.status,
        decidedVia: details.decidedVia,
        decidedAt: details.decidedAt?.toISOString() ?? null,
        decidedById: details.decidedById,
      },
    });
  }
}

/**
 * The exception for a row that is no longer decidable, chosen by its state.
 *
 * One function rather than four throw sites, so `decide` and its conditional
 * update loser branch cannot drift into describing the same state two
 * different ways.
 */
export function notPendingFor(row: {
  id: string;
  status: ApprovalStatus;
  decidedVia: ApprovalDecidedVia | null;
  decidedAt: Date | null;
  decidedById: string | null;
  timeoutPolicy: string;
}): ApprovalNotPendingException {
  const details = {
    approvalId: row.id,
    status: row.status,
    decidedVia: row.decidedVia,
    decidedAt: row.decidedAt,
    decidedById: row.decidedById,
  };
  const when = row.decidedAt ? row.decidedAt.toISOString() : 'an unknown time';

  if (row.status === 'superseded') {
    return new ApprovalNotPendingException(
      'superseded',
      `Approval ${row.id} was superseded at ${when}: the condition it was ` +
        'raised about changed before anyone had to answer. Nobody refused ' +
        'it. If the action is still wanted, raise it again.',
      details,
    );
  }

  if (row.status === 'auto_approved' || row.status === 'auto_denied') {
    const verdict = row.status === 'auto_approved' ? 'approved' : 'denied';
    return new ApprovalNotPendingException(
      'already-timed-out',
      `Approval ${row.id} timed out at ${when} and was auto-${verdict} by ` +
        `its recorded "${row.timeoutPolicy}" policy — the consequence of ` +
        'silence it was raised with (ADR-0014). No human decided it, so it ' +
        'is not evidence either way for this action class.',
      details,
    );
  }

  if (row.decidedVia === 'grant') {
    return new ApprovalNotPendingException(
      'already-authorized-by-grant',
      `Approval ${row.id} was authorized by a standing trust grant at ` +
        `${when} and was never a human-facing question. This row is the ` +
        'record of what would have been asked (VISION §8); it is not a ' +
        'decision waiting to be made.',
      details,
    );
  }

  if (row.decidedVia === 'human') {
    const who =
      row.decidedById ?? 'a user whose account has since been removed';
    const verdict = row.status === 'approved' ? 'approved' : 'denied';
    return new ApprovalNotPendingException(
      'already-decided-by-human',
      `Approval ${row.id} was already ${verdict} by ${who} at ${when}. The ` +
        'first verdict stands — two people reaching for the same request at ' +
        'once is normal, and the earlier one is the true one.',
      details,
    );
  }

  // Not reachable through any write this service makes: every resolved status
  // is covered above. Kept, and deliberately vague rather than silent, because
  // a row in a state this function cannot name is a bug worth surfacing as
  // itself instead of being mislabelled as one of the four real cases.
  return new ApprovalNotPendingException(
    'not-pending',
    `Approval ${row.id} is in status "${row.status}" and cannot be decided. ` +
      'This combination of status and decidedVia is not one the approval ' +
      'gate writes; the row is inconsistent.',
    details,
  );
}
