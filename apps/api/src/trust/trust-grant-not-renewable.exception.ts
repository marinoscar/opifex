import { ConflictException } from '@nestjs/common';

/**
 * Why a grant could not be renewed (#115, epic #22).
 *
 * Four values rather than one message, for the reason `AuthorizationDenial`
 * carries six: the operator's next move is COMPLETELY DIFFERENT per reason,
 * and a generic "cannot renew" leaves them to guess which. An expired grant
 * means make a new decision; a revoked one means somebody deliberately ended
 * this and renewing would undo their call; a suspended one means the evidence
 * turned against the class and the numbers are on the row; an ineligible class
 * means no grant of this kind may exist at all any more.
 */
export type TrustGrantNotRenewableReason =
  /**
   * The grant has lapsed. `status: 'expired'` AND the still-`active` row whose
   * `expiresAt` has passed because the sweep has not caught up — the same
   * "effective status" collapse `diagnoseNoGrant` makes, and for the same
   * reason: the timestamp is the authority, not the column, so a late sweep
   * must not change the answer.
   */
  | 'expired'
  /** A human ended it. Terminal — nothing reactivates a revoked grant. */
  | 'revoked'
  /** The system ended it on evidence: failure rate, cost, or a demotion. */
  | 'suspended'
  /** The registry no longer marks this class autonomy-eligible. */
  | 'class-ineligible';

/**
 * 409, with the reason in `details.reason`.
 *
 * ## Why 409 and not 400, including for `class-ineligible`
 *
 * Nothing the caller sent is malformed: the request body carries an optional
 * note and the path carries a grant id that resolved. What is wrong is the
 * STATE — of the grant, or of the registry the grant's class lives in. 404
 * would be a lie (the grant exists and is readable) and 400 would send a
 * client looking for a bad field. `ApprovalNotPendingException` makes the same
 * call for the same shape of problem.
 *
 * `class-ineligible` is included deliberately rather than split off as a 400
 * matching `TrustGrantService.create`. There the caller NAMED the class and
 * the class was the input; here they named a grant, and the class becoming
 * ineligible is something that happened to the world since the grant was
 * written. Both are refusals a client branches on via `details.reason`, which
 * is the discriminator that actually survives — `HttpExceptionFilter`
 * overwrites the envelope's `code` from the status.
 */
export class TrustGrantNotRenewableException extends ConflictException {
  constructor(
    readonly reason: TrustGrantNotRenewableReason,
    message: string,
    details: {
      grantId: string;
      actionClass: string;
      status: string;
      expiresAt: Date;
      endedAt: Date | null;
      endReason: string | null;
      endDetail: string | null;
    },
  ) {
    super({
      code: 'TRUST_GRANT_NOT_RENEWABLE',
      message,
      details: {
        reason,
        grantId: details.grantId,
        actionClass: details.actionClass,
        status: details.status,
        expiresAt: details.expiresAt.toISOString(),
        endedAt: details.endedAt?.toISOString() ?? null,
        endReason: details.endReason,
        endDetail: details.endDetail,
      },
    });
  }
}
