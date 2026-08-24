import type { ApprovalTimeoutPolicy } from '@prisma/client';

import type { NotificationPayload } from './notification-payload';

/**
 * What arrives on the phone when the gate has to ask a person (#98, VISION §8).
 *
 * The escalation builder next door (`buildPayload`) reads its blast radius and
 * its consequence-for-silence out of a per-kind `CONSEQUENCES` table, because
 * an escalation is a THING THAT HAPPENED and only the kind knows what it costs
 * to ignore. An approval is the opposite: it is a thing that has NOT happened,
 * raised with its own `summary`, `reasoning` and `blastRadius` already written
 * by whoever asked (`RaiseApprovalInput` makes all three required, ADR-0013),
 * and rewriting them into a canned per-class sentence here would discard the
 * only description of the specific action under question.
 *
 * So three of VISION §8's four fields are passed through, and the fourth —
 * "what happens if ignored" — is DERIVED, and derived from one specific place.
 * See `ifIgnoredFor`.
 */

/**
 * The subset of an approval this builder needs.
 *
 * Structural rather than the Prisma row or `ApprovalRequestView`, matching
 * `EscalationForNotification`: the builder is a pure function and should be
 * callable from a spec with a literal, and from the gate with the row it just
 * wrote, without either side owning the other's shape.
 */
export interface ApprovalForNotification {
  id: string;
  /** A registry id where possible; an unrecognised string is tolerated. */
  actionClass: string;
  /**
   * The ADR-0011 registry title for `actionClass`, RESOLVED BY THE CALLER.
   *
   * It would be shorter to call `getActionClass` here. It is not allowed, and
   * the constraint is a real one rather than a style preference: the governing
   * test for #94 asserts that nothing under `src/notifications/` imports
   * anything from `src/supervisor/`, because "escalation to a human" is on
   * VISION §7's left-hand column — the behaviours that must keep working with
   * the supervisor offline. The registry is a frozen array with no I/O in it,
   * so importing it would be harmless TODAY; the rule fires on the import
   * precisely because #94 predicts the erosion arrives "one convenient
   * dependency at a time, each individually reasonable," and this is exactly
   * such a dependency. The lookup happens one layer up, in
   * `ApprovalGateService`, which is not on the hot path and already consumes
   * the registry.
   *
   * Null or absent falls back to the raw class id — see `titleFor`.
   */
  actionClassTitle?: string | null;
  summary: string;
  reasoning: string;
  blastRadius: string;
  /**
   * The RECORDED policy, never a recomputed one.
   *
   * This is the field the whole builder turns on, and the reason it is the
   * recorded one is the same reason `sweepTimeouts` uses the recorded one: the
   * sentence written from it is the PROMISE the operator is given, and the
   * sweeper must later keep exactly that promise. A registry edit between the
   * raise and the timeout would make a recomputed policy differ from the
   * notified one, and the system would then do something other than what it
   * said it would, overnight, with nothing in the notification history saying
   * so.
   */
  timeoutPolicy: ApprovalTimeoutPolicy;
  /** Null exactly when `timeoutPolicy` is `park_and_escalate`. */
  timeoutAt: Date | null;
  /** `pending` or `parked`. Anything else is not a question. */
  status: string;
  /**
   * The escalation raised for a parked approval, when one was raised.
   *
   * Null for every other approval, and that is not an omission — see the
   * `escalationId` note on the returned payload below.
   */
  escalationId?: string | null;
  /**
   * A delivery-receipt token for the LINKED ESCALATION, if the caller holds
   * one.
   *
   * Nothing in the approval path mints one, and nothing should: receipt tokens
   * are issued by `EscalationDispatcher` against an escalation row. This field
   * exists so that a caller which already has one for the linked escalation
   * can pass it through rather than the payload silently dropping it.
   */
  receiptId?: string | null;
  createdAt: Date;
}

export function buildApprovalPayload(
  approval: ApprovalForNotification,
  appUrl: string,
): NotificationPayload {
  const parked = approval.status === 'parked';

  // ## Why `escalationId` is usually absent, and why that is deliberate
  //
  // `NotificationPayload.escalationId` is optional because "not everything
  // sent through this transport is an escalation" — the daily brief (#93) is
  // the other example. An approval is a THIRD such thing: the gate raised a
  // question, it did not report a stall. Minting an `Escalation` row so this
  // payload could carry an id would put every approval into the escalation
  // lifecycle and into the stop-to-notified percentiles computed over it
  // (VISION success metric 1), which measures how long a BROKEN RUN went
  // unnoticed. An approval nobody has answered yet is not a broken run, and
  // counting it as one would make the metric report a detection problem that
  // does not exist.
  //
  // A `parked` approval is the one case where a real escalation already
  // exists: `ApprovalGateService.escalateParked` raises one, because VISION §8
  // requires a human be told about the never-auto-approve case rather than it
  // closing silently. That id is passed through — it is a real row, already in
  // the lifecycle, not one minted for the sake of this field.
  const escalationId =
    parked && approval.escalationId ? approval.escalationId : undefined;

  // The receipt is a DELIVERY RECEIPT, not an authorization. It only ever
  // travels with an escalation it can resolve to; issuing one here for an
  // approval would hand the receipt endpoint a credential that names nothing.
  const receiptId =
    escalationId !== undefined && approval.receiptId
      ? approval.receiptId
      : undefined;

  return {
    ...(escalationId !== undefined ? { escalationId } : {}),
    ...(receiptId !== undefined ? { receiptId } : {}),
    // `high` for the parked case, `normal` for everything else.
    //
    // This is VISION §8's batching rule applied to the one fact that changes
    // the answer: a parked approval has NO TIMER (ADR-0014 rule 1), so silence
    // resolves it never. Every other policy resolves itself within the
    // four-hour window whether or not the phone lights up, which is precisely
    // the "decisions batched and moved off the critical path" case — an
    // interruption buys nothing there but the interruption. Sending everything
    // at `high` is how an operator learns to swipe approvals away, and an
    // operator who swipes is the operator who blanket-grants trust "while
    // annoyed rather than while thinking".
    priority: parked ? 'high' : 'normal',
    title: titleFor(approval),
    // WHAT. The summary as raised, unedited.
    body: approval.summary,
    // WHY. Passed through for the reason `buildPayload` passes `detail`
    // through: #47's rule that a summarised reason is one the operator cannot
    // check, and the operator is being asked to judge this argument.
    why: approval.reasoning,
    // BLAST RADIUS. Also as raised — the caller knows what else this touches;
    // a sentence derived from the class would be true of the class and not
    // necessarily of this instance.
    blastRadius: approval.blastRadius,
    ifIgnored: ifIgnoredFor(approval.timeoutPolicy, approval.timeoutAt),
    // Straight to the one approval, not to a queue the operator then has to
    // search. VISION §8's "one tap" is literal, and a deep link into a list is
    // two taps and a scroll on a phone at 2am.
    //
    // The link carries NO AUTHORITY. It is a URL into the authenticated app,
    // and the decision endpoint requires a real session with
    // `approvals:decide` — see the comment on `ApprovalsController`.
    url: `${appUrl}/approvals/${approval.id}`,
    kind: 'approval_request',
    raisedAt: approval.createdAt.toISOString(),
  };
}

/**
 * "What happens if ignored", derived from the RECORDED timeout policy.
 *
 * This is the field VISION §8 says decides whether to get up, and it is the
 * one place in the system where the promise about silence is actually made to
 * a human. Everything else — `timeoutPolicy` on the row, `timeoutAtFor`'s
 * null, `sweepTimeouts` switching on the recorded value — exists so that this
 * sentence stays true.
 *
 * ## Derived from the policy, not from the class
 *
 * Writing this from `reversibility` or `spendsMoney` would re-derive
 * ADR-0014's total order a second time, in a second place, with the resolution
 * order implicit in whichever `if` was written first. That is exactly the
 * duplication #97 forbids ("consume the existing reversibility classification
 * rather than defining a second one"), and the failure mode is the worst
 * available: the notification says one thing will happen and the sweeper does
 * another, four hours later, while the operator is asleep and has no way to
 * discover which one was the lie.
 *
 * ## The parked sentence must not imply a deadline
 *
 * `park_and_escalate` has `timeoutAt === null` and that null IS the
 * never-auto-approve guarantee. A sentence with a time in it — even a
 * hedged one, even "it will be reviewed by morning" — describes a timer that
 * does not exist, and an operator who believes a deadline exists is an
 * operator who will let it lapse expecting something to happen. Nothing will.
 * Its spec asserts the absence of any time-shaped substring for this reason.
 */
export function ifIgnoredFor(
  policy: ApprovalTimeoutPolicy,
  timeoutAt: Date | null,
): string {
  if (policy === 'park_and_escalate') {
    return (
      'Nothing happens, ever, until a person answers this. There is no ' +
      'timer on it: this action can never be approved by silence, under any ' +
      'trust grant (VISION §8, ADR-0014 rule 1). It will still be here ' +
      'tomorrow, and the work behind it stays blocked until then.'
    );
  }

  // The invariant is that a timed policy always carries an instant
  // (`timeoutAtFor` returns one for both of them). It is not asserted here
  // because a builder that throws would turn "we could not phrase the
  // notification" into "the operator was never told", and being told with a
  // vaguer sentence beats not being told. The vaguer sentence still names the
  // right OUTCOME, which is the part that has to be true.
  const when = timeoutAt
    ? `at ${timeoutAt.toISOString()}`
    : 'when its window closes';

  if (policy === 'auto_approve') {
    return (
      `Nobody has to do anything: this will proceed on its own ${when}, and ` +
      'the fact that it ran without a human looking is recorded either way, ' +
      'so it appears in the daily brief.'
    );
  }

  return (
    `It will be refused ${when} — nothing happens, no money is spent, and ` +
    'nothing is changed. A refusal by silence is not a judgement about the ' +
    'action, so it can be raised again.'
  );
}

/**
 * A lock-screen title naming the class, not its id.
 *
 * `re-dispatch` is a partition key. "Re-dispatch after transient failure" is
 * what a person half-awake can act on, and it is already written down once in
 * the ADR-0011 registry — which is why the caller resolves it there rather
 * than this file keeping a second copy.
 *
 * An unresolved class falls back to its raw ID rather than to a generic
 * string. The gate parks unknown classes (ADR-0014's conservative default),
 * and ADR-0014 is explicit that a parked approval today most likely means "a
 * class id the gate did not recognize" rather than "an irreversible action" —
 * so the raw id is the single most useful thing the notification can show in
 * that case, and "Approve: an unknown action" would be the least.
 */
function titleFor(approval: ApprovalForNotification): string {
  return `Approve: ${approval.actionClassTitle ?? approval.actionClass}`;
}
