import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  ApprovalDecidedVia,
  ApprovalStatus,
  ApprovalTimeoutPolicy,
  Prisma,
} from '@prisma/client';

import type { AutonomyEffect } from '../autonomy/never-trustable';
import { NeverTrustableService } from '../autonomy/never-trustable.service';
import { toNumberOrNull, type DecimalLike } from '../common/decimal';
import { EscalationsService } from '../escalations/escalations.service';
import { ApprovalNotifier } from '../notifications/approval-notifier.service';
import type { ApprovalForNotification } from '../notifications/approval-payload';
import { PrismaService } from '../prisma/prisma.service';
import {
  getActionClass,
  isActionClass,
  isAutonomyEligible,
  spendsMoney,
} from '../supervisor/action-classes';
import { defaultGrantAttributes } from '../trust/defaults';
import { TrustGrantService } from '../trust/trust-grant.service';
import { notPendingFor } from './approval-not-pending.exception';
import type {
  ApprovalRequestView,
  ClassApprovalRates,
  DecideApprovalInput,
  DecideResult,
  GateOutcome,
  ListPendingQuery,
  RaiseApprovalInput,
  SweepTimeoutsResult,
} from './approval.types';
import { resolveTimeoutPolicy, timeoutAtFor } from './timeout-policy';

/**
 * How many due requests one sweep resolves.
 *
 * A bound rather than "all of them" because the sweeper runs on the scheduler
 * that also carries the reconciler's cleanup and the run-summary pass, and a
 * backlog of ten thousand rows should be worked through over several ticks
 * rather than in one transaction that holds the loop. At five-minute ticks
 * this drains 2,400 rows an hour, which is far more approval traffic than
 * VISION §8's "batched, off the critical path" model would ever produce.
 */
export const SWEEP_BATCH_LIMIT = 200;

/**
 * The two statuses meaning "a human has not answered this yet".
 *
 * Exported because `listPending` and `decide` must ask the same question:
 * `parked` is not a resolution, it is `pending` with no timer. A second
 * opinion about which statuses are open would mean the queue shows a request
 * nobody can decide, or hides one that is waiting — the same drift argument
 * `EscalationsService.UNRESOLVED` makes about its own set.
 */
export const OPEN_STATUSES: readonly ApprovalStatus[] = ['pending', 'parked'];

/**
 * The approval gate (#97, epic #22, VISION §8, ADR-0013, ADR-0014).
 *
 * One question — "may this action proceed" — asked in a fixed order that is
 * itself the safety property:
 *
 *   0. Never-trustable effects, refused outright (ADR-0013). Before anything.
 *   1. A standing trust grant, which bypasses the human entirely (#96).
 *   2. Otherwise a human, with a stated consequence for silence (ADR-0014).
 *
 * ## The grant, not the timeout, is what delivers autonomy
 *
 * ADR-0014's headline consequence, repeated here because it is the thing most
 * likely to be misread: under the total order, EVERY autonomy-eligible class
 * with a real effect denies on timeout, because `re-dispatch`, `decomposition`
 * and `issue-shaping` are all `spendsMoney: true`. Auto-approve-on-timeout
 * applies only to the three classes that change nothing outside the decision
 * log. So this gate exists mostly to be BYPASSED by a valid grant. Someone
 * will eventually try to make autonomy work by loosening `timeout-policy.ts`;
 * that removes a safety property instead of adding a capability. Create a
 * grant.
 *
 * ## What it does not do
 *
 * It executes nothing. No dispatcher, no GitHub client, no runner — the module
 * graph makes that structural rather than a matter of restraint, exactly as
 * `TrustModule` and `SupervisorModule` argue for themselves. It also serves no
 * HTTP: #98 owns the surface, and the permission split it must enforce is
 * documented on `DecideApprovalInput.alwaysApproveThisClass`.
 */
@Injectable()
export class ApprovalGateService {
  private readonly logger = new Logger(ApprovalGateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly neverTrustable: NeverTrustableService,
    private readonly grants: TrustGrantService,
    private readonly escalations: EscalationsService,
    private readonly notifier: ApprovalNotifier,
  ) {}

  // -------------------------------------------------------------------------
  // The gate
  // -------------------------------------------------------------------------

  /**
   * Ask the question. #97's whole point.
   *
   * The ORDER of the three steps below is load-bearing and is not an
   * implementation detail to be tidied up later.
   */
  async gate(
    input: RaiseApprovalInput,
    now: Date = new Date(),
  ): Promise<GateOutcome> {
    // ---- 0. Never-trustable, FIRST, before anything else ------------------
    //
    // #97's last acceptance criterion is that a forbidden action is "refused
    // before the engine is even consulted", and ADR-0014 lists this as rule 0
    // of the total order for the same reason. It runs before the grant lookup
    // so that no grant, however permissive, can be the reason a force-push or
    // a credential read proceeds — VISION §8's phrase is "regardless of any
    // grant", and the only way to make that true is to not consult grants yet.
    const verdict = await this.neverTrustable.enforce({
      actionClass: input.actionClass,
      effects: input.effects,
      ...(input.targetRef ? { targetRef: input.targetRef } : {}),
      ...(input.proposalId ? { proposalId: input.proposalId } : {}),
    });

    if (!verdict.permitted) {
      // NO `ApprovalRequest` ROW IS WRITTEN, and this is a real design choice
      // whose opposite is the obvious implementation.
      //
      // Writing one would put a question in the operator's queue that cannot
      // be answered: approving it changes nothing, because #95 refuses the
      // effects again at the execution boundary regardless — so the row would
      // be an interrupt with no possible action behind it, which is precisely
      // the approval fatigue VISION §8 exists to eliminate. Worse, an
      // `approved` row for a never-trustable action would sit in #99's
      // numerator as evidence that humans endorse a class of action the system
      // will never perform.
      //
      // The refusal is not lost: `NeverTrustableService.enforce` has already
      // written an `autonomy.refused` audit row naming every matched rule
      // (ADR-0013), which is the record that matters — repeated attempts are
      // how a misbehaving proposer first shows up, and that signal belongs in
      // the audit log rather than in a queue of things to decide.
      return { outcome: 'refused', refusals: verdict.refusals };
    }

    // ---- Resolved once, used by every branch below -------------------------
    //
    // Computed even for the grant path. A grant-authorized row still records
    // what WOULD have been asked (VISION §8), and "what would have happened if
    // nobody answered" is part of that record — #100's digest reads it to say
    // what the alternative to the grant was.
    const timeoutPolicy = resolveTimeoutPolicy(input.actionClass);

    // ---- 1. A standing grant --------------------------------------------
    const authorization = await this.grants.authorize(
      input.actionClass,
      input.repositoryId,
      this.projectedCostFor(input),
      now,
    );

    if (authorization.authorized) {
      // ONE representation, chosen deliberately: `status: 'approved'` with
      // `decidedVia: 'grant'`.
      //
      // The alternative was a fifth status, `grant_approved`. It loses because
      // `decidedVia` is ALREADY the axis that separates human evidence from
      // machine action — it exists for exactly this distinction, and encoding
      // the same fact in `status` as well would create two columns that can
      // disagree, which is the drift argument ADR-0011 and ADR-0013 both make.
      // `status` answers "what happened to this action"; `decidedVia` answers
      // "who or what decided". A grant-authorized action WAS approved; the
      // interesting fact is by what.
      //
      // The cost of this choice is that #99 must filter on `decidedVia` and
      // not on `status` alone, and a query that forgets to would silently
      // count machine action as human evidence. That is why the exclusion is
      // made explicit in `approvalRatesByClass` and covered by its own test
      // rather than left as a convention each consumer re-implements.
      const created = await this.prisma.approvalRequest.create({
        data: {
          ...this.baseData(input, timeoutPolicy),
          // No timer on a row that is already decided. Null here, as for a
          // parked row, means "nothing will resolve this later" — true for
          // opposite reasons in the two cases, and true in both.
          timeoutAt: null,
          status: 'approved',
          decidedAt: now,
          decidedById: null,
          decidedVia: 'grant',
          decisionNote:
            `Authorized by trust grant ${authorization.grant.id} ` +
            `(${input.actionClass} on this repository, expires ` +
            `${authorization.grant.expiresAt}). No human was asked; this row ` +
            'is the record of what would have been (VISION §8).',
          grantId: authorization.grant.id,
        },
        select: { id: true },
      });

      return {
        outcome: 'authorized',
        grantId: authorization.grant.id,
        approvalId: created.id,
      };
    }

    // ---- 2. Ask a human --------------------------------------------------
    const timeoutAt = timeoutAtFor(timeoutPolicy, now);
    const parked = timeoutPolicy === 'park_and_escalate';

    const created = await this.prisma.approvalRequest.create({
      data: {
        ...this.baseData(input, timeoutPolicy),
        timeoutAt,
        // `parked` rather than `pending` for the never-auto-approve case. The
        // schema's `ApprovalStatus` doc is explicit that this status is "the
        // 'never auto-approve' guarantee expressed as a status with no exit
        // but a person", and it pairs with the null `timeoutAt`: two
        // independent expressions of the same invariant, so a query that
        // filters on either one gets the right answer.
        status: parked ? 'parked' : 'pending',
      },
      // `createdAt` because the notification stamps when the question was
      // raised, so one that arrives late says so rather than looking fresh.
      select: { id: true, createdAt: true },
    });

    const escalationId = parked
      ? await this.escalateParked(created.id, input, authorization.detail)
      : null;

    this.logger.log(
      `Approval ${created.id} raised for ${input.actionClass}: ` +
        `${timeoutPolicy}${timeoutAt ? ` at ${timeoutAt.toISOString()}` : ''} ` +
        `(no grant: ${authorization.detail})`,
    );

    await this.notify({
      id: created.id,
      actionClass: input.actionClass,
      // Resolved HERE and not in the payload builder. `src/notifications/` is
      // on VISION §7's hot path — "escalation to a human" — and #94's
      // governing test forbids anything under it importing
      // `src/supervisor/`, so the registry lookup happens on this side of the
      // seam. This service already consumes the same registry three lines up.
      actionClassTitle: getActionClass(input.actionClass)?.title ?? null,
      summary: input.summary,
      reasoning: input.reasoning,
      blastRadius: input.blastRadius,
      timeoutPolicy,
      timeoutAt,
      status: parked ? 'parked' : 'pending',
      escalationId,
      createdAt: created.createdAt ?? now,
    });

    return {
      outcome: 'pending',
      approvalId: created.id,
      timeoutPolicy,
      timeoutAt,
    };
  }

  /**
   * The cost figure handed to the grant's budget check.
   *
   * NULL IS NOT ZERO, and which of the two it means depends on the class.
   *
   * For a class the registry marks `spendsMoney: false`, an absent estimate
   * genuinely is no cost: the effect changes nothing outside the decision log,
   * so zero is a measurement rather than a guess.
   *
   * For a `spendsMoney` class, an absent estimate means the gate COULD NOT
   * PRICE THE ACTION, and `ApprovalRequest.estimatedCostUsd`'s own schema
   * comment is blunt about the consequence: "A `spendsMoney` action whose cost
   * could not be estimated is not a free action; it is an action the gate
   * could not price and must not treat as costing nothing." Passing 0 would
   * make the grant's budget ceiling pass for exactly the actions it cannot
   * check — the one way this refusal could fail in the flattering direction.
   *
   * So it passes `NaN`, and lets `TrustGrantService.authorize` refuse it with
   * the sentence it already owns for this case ("An unknown cost is not a zero
   * cost, so it cannot be checked against a budget ceiling"). Deliberately not
   * a second copy of that rule here: `authorize`, `checkNeverTrustable` and
   * `spend-ledger` all already agree that a non-finite figure is unreported
   * rather than free, and a fourth implementation is a fourth thing to drift.
   * The outcome is that the request falls through to a human, which is the
   * correct disposition for an action nobody can put a price on.
   */
  private projectedCostFor(input: RaiseApprovalInput): number {
    const estimate = input.estimatedCostUsd;

    if (estimate !== null && estimate !== undefined) {
      return estimate;
    }

    return spendsMoney(input.actionClass) ? Number.NaN : 0;
  }

  /** The columns every raise writes, whichever branch it takes. */
  private baseData(
    input: RaiseApprovalInput,
    timeoutPolicy: ApprovalTimeoutPolicy,
  ): Omit<Prisma.ApprovalRequestUncheckedCreateInput, 'status' | 'timeoutAt'> {
    return {
      actionClass: input.actionClass,
      repositoryId: input.repositoryId,
      proposalId: input.proposalId ?? null,
      targetKind: input.targetKind ?? null,
      targetRef: input.targetRef ?? null,
      summary: input.summary,
      reasoning: input.reasoning,
      blastRadius: input.blastRadius,
      // Frozen at raise time (ADR-0013): a later change to `effectsFor` must
      // not retroactively change what a historical approval is understood to
      // have authorized.
      effects: input.effects as unknown as Prisma.InputJsonValue,
      estimatedCostUsd: input.estimatedCostUsd ?? null,
      timeoutPolicy,
    };
  }

  /**
   * Tell a human about a parked request, and link the escalation to it.
   *
   * The approval row is written BEFORE this runs, and that order is
   * deliberate: the safety-relevant fact is that the action is blocked, and it
   * must be durable even if the notification path is down. Raising the
   * escalation first and the row second would risk a page about a request that
   * does not exist.
   *
   * A failure here is logged and swallowed, on the same reasoning
   * `NeverTrustableService.record` gives for its audit write: the block has
   * already been decided and stands whether or not this lands, and a gate
   * whose refusal depends on a successful second write is a gate that fails
   * open under exactly the load that makes writes fail.
   *
   * The cost of swallowing is real and worth naming rather than implying: a
   * parked approval with a null `escalationId` is a question nobody was told
   * about, which is the failure VISION §9 says this project exists to
   * eliminate. It is at least VISIBLE — the row is queryable, and the log line
   * is an error — but nothing re-attempts it today. See the follow-up note in
   * #98/#100 territory: a backfill for parked rows with no escalation.
   */
  private async escalateParked(
    approvalId: string,
    input: RaiseApprovalInput,
    noGrantDetail: string,
  ): Promise<string | null> {
    try {
      const escalation = await this.escalations.raiseSystem({
        summary: `Approval parked, waiting on a human: ${input.summary}`,
        detail:
          `${input.reasoning}\n\nBlast radius: ${input.blastRadius}\n\n` +
          'If ignored: nothing. This action class is irreversible, so it is ' +
          'never auto-approved under any grant or any timeout (VISION §8, ' +
          'ADR-0014 rule 1). There is no timer on this request — it waits ' +
          `until a person answers it.\n\nGrant: ${noGrantDetail}\n` +
          `Approval: ${approvalId}`,
      });

      await this.prisma.approvalRequest.update({
        where: { id: approvalId },
        data: { escalationId: escalation.id },
      });

      return escalation.id;
    } catch (error) {
      this.logger.error(
        `Approval ${approvalId} is parked but nobody was told — escalation ` +
          `failed: ${describeError(error)}`,
      );
      return null;
    }
  }

  /**
   * Put the question on a phone. VISION §8's "one tap from a phone."
   *
   * ## A failed send must never turn a raised approval into a failure
   *
   * Everything in here is wrapped and swallowed, and the asymmetry is the
   * whole reason: AN APPROVAL THAT EXISTS AND WAS NOT DELIVERED IS
   * RECOVERABLE — the row is written, `GET /api/approvals` lists it, the
   * cockpit shows it, and its recorded timeout policy still resolves it — WHILE
   * AN APPROVAL THAT WAS NEVER WRITTEN IS NOT. Letting a push-service outage
   * propagate out of `gate` would make the caller's action fail for a reason
   * that has nothing to do with whether it may proceed, and the caller's most
   * likely recovery is to retry, producing a second question about the same
   * action or, worse, an action taken without a gate at all.
   *
   * `NeverTrustableService.record` and `escalateParked` swallow for the same
   * reason. The cost is real and named there too: a raise nobody was told
   * about is the failure VISION §9 exists to eliminate. It is at least VISIBLE
   * — the row is queryable and `ApprovalNotifier` logs a warning naming the
   * approval — but nothing re-attempts it today.
   *
   * ## The parked case may notify twice, deliberately
   *
   * A parked approval already raised an `Escalation`, and the dispatcher will
   * send that separately. The two are not redundant: the escalation payload
   * deep-links to the escalation list and exists to prove somebody was TOLD
   * (it carries a receipt), while this one deep-links to the approval itself
   * and exists to let them ACT — which VISION §8 requires be one tap.
   * `buildApprovalPayload` passes the escalation id through on exactly this
   * case so a device can group the pair rather than showing two unrelated
   * alerts.
   */
  private async notify(approval: ApprovalForNotification): Promise<void> {
    try {
      await this.notifier.send(approval);
    } catch (error) {
      // `ApprovalNotifier.send` contracts never to throw. Caught anyway: the
      // durability of a raised approval must not depend on another class
      // keeping a promise, because the failure would be silent here and total
      // — the row is already committed and the exception would discard the
      // outcome the caller needs.
      this.logger.error(
        `Approval ${approval.id} was raised but could not be notified: ` +
          `${describeError(error)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // The human path
  // -------------------------------------------------------------------------

  /**
   * A person's verdict. VISION §8's "one tap from a phone."
   *
   * ## The race with the sweeper is settled by the database
   *
   * The status change is a conditional `updateMany` filtered on the row still
   * being open, so a human answering at the same instant the sweeper resolves
   * the row produces exactly one winner and one clear error, rather than two
   * writes and a last-one-wins result. Reading, then deciding, then writing
   * would leave a window in which both succeed and the row's `decidedVia`
   * contradicts its `decisionNote`.
   *
   * ## An approval decided after its timeout still counts as human
   *
   * If `timeoutAt` has passed but the sweeper has not reached the row, the row
   * is still `pending` and the human's verdict wins. The RECORDED STATE is the
   * authority — nothing has resolved it yet, so nothing has to be overridden —
   * and the alternative, refusing a late human, would auto-deny the action and
   * make the operator raise it again, which is the friction VISION §8 opens by
   * naming. The result carries `decidedAfterTimeout` so the caller can SAY the
   * window had lapsed instead of leaving the operator to wonder.
   */
  async decide(
    approvalId: string,
    input: DecideApprovalInput,
    now: Date = new Date(),
  ): Promise<DecideResult> {
    const existing = await this.prisma.approvalRequest.findUnique({
      where: { id: approvalId },
    });

    if (!existing) {
      throw new NotFoundException(`Approval request ${approvalId} not found`);
    }

    if (!OPEN_STATUSES.includes(existing.status)) {
      throw notPendingFor(existing);
    }

    const approve = input.decision === 'approve';
    const decidedAfterTimeout =
      existing.timeoutAt !== null &&
      existing.timeoutAt.getTime() <= now.getTime();

    const { count } = await this.prisma.approvalRequest.updateMany({
      // The `status` clause is the lock. Dropping it would let a human write
      // over a timeout resolution that already happened.
      where: {
        id: approvalId,
        status: { in: OPEN_STATUSES as ApprovalStatus[] },
      },
      data: {
        status: approve ? 'approved' : 'denied',
        decidedAt: now,
        decidedById: input.actorUserId,
        decidedVia: 'human',
        decisionNote: input.note ?? null,
      },
    });

    if (count === 0) {
      // Somebody else got there between the read and the write. Re-read so the
      // error names what actually happened rather than what we saw a moment
      // ago.
      const current = await this.prisma.approvalRequest.findUnique({
        where: { id: approvalId },
      });
      if (!current) {
        throw new NotFoundException(`Approval request ${approvalId} not found`);
      }
      throw notPendingFor(current);
    }

    const grant = approve
      ? await this.maybeMintGrant(existing, input, now)
      : {
          createdGrantId: null,
          grantSkippedReason: input.alwaysApproveThisClass
            ? '"Always approve this class" applies only to an approval. This ' +
              'request was denied, so no trust grant was created.'
            : null,
        };

    const updated = await this.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approvalId },
    });

    return {
      approval: toView(updated),
      createdGrantId: grant.createdGrantId,
      grantSkippedReason: grant.grantSkippedReason,
      decidedAfterTimeout,
    };
  }

  /**
   * VISION §8's third option, and its two refusals.
   *
   * The attributes are NEVER assembled here. `defaultGrantAttributes(now)`
   * supplies all four — scope is the approval's own class and repository,
   * expiry, budget ceiling and auto-revoke thresholds come from `defaults.ts`
   * — because VISION §8's claim is that the third tap "silently attaches all
   * four", and that is a claim about code: a caller assembling its own expiry
   * would be safe wherever somebody remembered and unbounded wherever they did
   * not, and the unbounded one is the one written at 2am.
   *
   * There is no widening path from here at all. An operator who genuinely
   * wants a broader grant creates one explicitly through `TrustGrantService.
   * create`, where the numbers they chose are recorded as their choice.
   *
   * Both refusals are REPORTED, never silent: a flag that quietly does nothing
   * is how an operator comes to believe they hold a grant they do not, and
   * then stops watching a class nobody promoted.
   */
  private async maybeMintGrant(
    approval: {
      id: string;
      actionClass: string;
      repositoryId: string;
      proposalId: string | null;
    },
    input: DecideApprovalInput,
    now: Date,
  ): Promise<{
    createdGrantId: string | null;
    grantSkippedReason: string | null;
  }> {
    if (input.alwaysApproveThisClass !== true) {
      return { createdGrantId: null, grantSkippedReason: null };
    }

    // The class-eligibility check that `TrustGrantService.create` would also
    // make. Duplicated on purpose rather than caught as an exception: the
    // single action still gets approved either way, and the operator needs a
    // sentence about the FLAG, not a 400 that discards their verdict.
    //
    // `isActionClass` narrows as well as validates, which is what lets the
    // `create` call below take a real `ActionClassId` instead of a cast — an
    // unregistered string reaching `TrustGrantService.create` would be a grant
    // for a scope nothing can ever match, which reads as "trust granted" on
    // every screen that lists it.
    if (
      !isActionClass(approval.actionClass) ||
      !isAutonomyEligible(approval.actionClass)
    ) {
      const reason =
        `Action class "${approval.actionClass}" is not autonomy-eligible ` +
        '(VISION §7 ranks it last and annotates it "probably never"; VISION ' +
        '§8 puts it on the never-trustable list). This action was approved; ' +
        'no trust grant was created, and proposals of this class will keep ' +
        'requiring a human decision.';
      this.logger.warn(`Approval ${approval.id}: ${reason}`);
      return { createdGrantId: null, grantSkippedReason: reason };
    }

    try {
      const created = await this.grants.create(
        {
          actionClass: approval.actionClass,
          repositoryId: approval.repositoryId,
          grantedById: input.actorUserId,
          grantedFromProposalId: approval.proposalId,
          note:
            input.note ??
            `Created from "Always approve this class" on approval ${approval.id}.`,
          ...defaultGrantAttributes(now),
        },
        now,
      );

      await this.prisma.approvalRequest.update({
        where: { id: approval.id },
        // A SEPARATE column from `grantId`, per the schema: one grant may have
        // authorized a request and a different grant may be born from the
        // decision on it. Collapsing them would make #100's digest unable to
        // tell "ran under existing trust" from "is the reason new trust
        // exists".
        data: { createdGrantId: created.id },
      });

      return { createdGrantId: created.id, grantSkippedReason: null };
    } catch (error) {
      // The verdict has already landed and stands. Reporting the failure
      // rather than rethrowing keeps the human's decision — which is the part
      // that was hard to obtain — and tells them the grant is the part that
      // did not happen.
      const reason =
        'The action was approved, but the trust grant could not be created: ' +
        `${describeError(error)}. Nothing runs unattended as a result of ` +
        'this decision.';
      this.logger.error(`Approval ${approval.id}: ${reason}`);
      return { createdGrantId: null, grantSkippedReason: reason };
    }
  }

  // -------------------------------------------------------------------------
  // The clock
  // -------------------------------------------------------------------------

  /**
   * Resolve every request whose window has closed.
   *
   * ## It uses the RECORDED policy, never a recomputed one
   *
   * `timeoutPolicy` is read off the row and switched on. It is NOT recomputed
   * from `ACTION_CLASSES` here, and that is the whole reason the column exists
   * (see its schema doc): the recorded value is what the operator was TOLD
   * would happen if they ignored the request — VISION §8 requires the
   * notification say "what happens if ignored". A registry edit between the
   * raise and the sweep, a reversibility reclassification, a `spendsMoney`
   * flip, would all make a recomputed policy differ from the promised one, and
   * the system would then do something other than what it said it would,
   * silently, overnight. The notification and the resolution must agree, and
   * freezing the decision at the moment it was communicated is the only way to
   * guarantee that.
   *
   * ## Parked rows are not reachable from here
   *
   * A `park_and_escalate` request has `timeoutAt === null` and `status:
   * 'parked'`, so the WHERE clause excludes it twice over. The `default` branch
   * below asserts on it anyway. That assertion is not the guarantee — the null
   * is (see `timeoutAtFor`) — it is DOCUMENTATION of the guarantee, placed
   * where someone editing the query will see it, and a loud failure if the
   * invariant is ever broken elsewhere rather than a silent auto-approval.
   */
  async sweepTimeouts(now: Date = new Date()): Promise<SweepTimeoutsResult> {
    const due = await this.prisma.approvalRequest.findMany({
      where: {
        status: 'pending',
        // `not: null` is redundant against `lte` in Prisma's semantics, and is
        // written anyway: the intent "rows that have a timer" should be
        // legible in the query rather than inferred from the comparison.
        timeoutAt: { not: null, lte: now },
      },
      select: {
        id: true,
        actionClass: true,
        timeoutPolicy: true,
        timeoutAt: true,
      },
      orderBy: { timeoutAt: 'asc' },
      take: SWEEP_BATCH_LIMIT,
    });

    const result: SweepTimeoutsResult = {
      examined: due.length,
      autoApproved: 0,
      autoDenied: 0,
      skippedParked: 0,
      raced: 0,
    };

    for (const row of due) {
      if (row.timeoutPolicy === 'park_and_escalate') {
        // Structurally unreachable: such a row is written with a null
        // `timeoutAt` and `status: 'parked'`, so the query above cannot return
        // it. Reaching here means the invariant was broken by something else,
        // and the correct response is to leave the request alone and say so —
        // never to fall through to a resolution. VISION §8: never
        // auto-approved, under any grant or any timeout.
        result.skippedParked += 1;
        this.logger.error(
          `Approval ${row.id} has policy park_and_escalate and a non-null ` +
            `timeoutAt (${row.timeoutAt?.toISOString() ?? 'null'}). That ` +
            'combination should not exist — it is left unresolved, because ' +
            'an irreversible action is never resolved by a timer (VISION §8).',
        );
        continue;
      }

      const approved = row.timeoutPolicy === 'auto_approve';
      const status: ApprovalStatus = approved ? 'auto_approved' : 'auto_denied';
      const deadline = row.timeoutAt?.toISOString() ?? 'the deadline';

      const { count } = await this.prisma.approvalRequest.updateMany({
        // Conditional on still being pending, so a human deciding in the same
        // instant wins and this becomes a no-op rather than an overwrite.
        where: { id: row.id, status: 'pending' },
        data: {
          status,
          decidedAt: now,
          decidedById: null,
          decidedVia: 'timeout',
          decisionNote:
            `Nobody answered before ${deadline}. Resolved to ${status} by ` +
            `the policy recorded when ` +
            `it was raised ("${row.timeoutPolicy}", ADR-0014) — the same ` +
            'consequence the request was announced with. This is silence, ' +
            'not a human verdict, and does not count as approval evidence ' +
            'for this action class.',
        },
      });

      if (count === 0) {
        result.raced += 1;
        continue;
      }

      if (approved) result.autoApproved += 1;
      else result.autoDenied += 1;
    }

    if (result.autoApproved > 0 || result.autoDenied > 0) {
      this.logger.log(
        `Approval timeout sweep: ${result.autoApproved} auto-approved, ` +
          `${result.autoDenied} auto-denied, ${result.raced} already decided ` +
          `(of ${result.examined} due).`,
      );
    }

    return result;
  }

  /**
   * Retire a request because the condition it was about changed.
   *
   * `superseded` is the one resolved status with a null `decidedVia`, and the
   * null is correct rather than an omission: nobody decided this. A human did
   * not refuse it, the clock did not resolve it, and no grant covered it — the
   * world moved on before anyone had to answer. Recording it as `denied` would
   * put a refusal nobody made into #99's denominator.
   *
   * A no-op on an already-resolved row, deliberately: the run finishing twice,
   * or two reconciler ticks noticing the same cancellation, is normal, and the
   * first resolution is the true one.
   */
  async supersede(
    approvalId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<ApprovalRequestView> {
    await this.prisma.approvalRequest.updateMany({
      where: {
        id: approvalId,
        status: { in: OPEN_STATUSES as ApprovalStatus[] },
      },
      data: {
        status: 'superseded',
        decidedAt: now,
        decidedById: null,
        decidedVia: null,
        decisionNote: reason,
      },
    });

    const row = await this.prisma.approvalRequest.findUnique({
      where: { id: approvalId },
    });
    if (!row) {
      throw new NotFoundException(`Approval request ${approvalId} not found`);
    }

    return toView(row);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * The queue: everything still waiting on a person.
   *
   * Includes `parked`. A parked request is the one that will wait FOREVER if
   * nobody looks, so a queue that filtered it out would hide precisely the
   * requests VISION §8 says are most worth surfacing. Oldest first, because
   * the oldest is the one that has been ignored longest.
   */
  async listPending(
    query: ListPendingQuery = {},
  ): Promise<ApprovalRequestView[]> {
    const rows = await this.prisma.approvalRequest.findMany({
      where: {
        // The narrowing filter replaces the two-status set rather than being
        // ANDed onto it, and the type of `query.status` is what keeps that
        // safe: it can only ever hold one of the two members already in
        // `OPEN_STATUSES`, so this can narrow the queue and cannot widen it.
        status: query.status ?? { in: OPEN_STATUSES as ApprovalStatus[] },
        ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
        ...(query.actionClass ? { actionClass: query.actionClass } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map(toView);
  }

  async get(id: string): Promise<ApprovalRequestView> {
    const row = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Approval request ${id} not found`);
    }
    return toView(row);
  }

  /**
   * Per-class evidence for #99's promotion ladder.
   *
   * ## A timeout is silence, not agreement
   *
   * The numerator is `approved AND decidedVia: 'human'` and the denominator is
   * that plus `denied AND decidedVia: 'human'`. Nothing else is in either.
   *
   * Counting `auto_approved` as an approval would let a class PROMOTE ITSELF
   * BY BEING IGNORED: every request times out under a `reversible` policy,
   * nobody is ever actually asked, and the ladder reads a perfect approval rate
   * over a population containing zero human opinions. VISION §7 grants trust
   * "on evidence, never in bulk", and evidence that the system generated for
   * itself is not evidence.
   *
   * Grant-authorized rows are excluded from BOTH numerator and denominator on
   * a related ground: they are machine action taken on trust a human extended
   * earlier, so counting them as fresh approvals would let a grant's own
   * authorisations re-attest to the trust that created them. They are reported
   * as their own number because #100's digest needs it — "what ran under
   * trust" is the digest's first question.
   */
  async approvalRatesByClass(
    sinceDays = 30,
    now: Date = new Date(),
  ): Promise<ClassApprovalRates[]> {
    const since = new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000);

    const groups = await this.prisma.approvalRequest.groupBy({
      // Three keys, not two. `status` alone cannot separate a human approval
      // from a grant authorisation — both are `approved` — which is the exact
      // filter this read model exists to apply on #99's behalf.
      by: ['actionClass', 'status', 'decidedVia'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });

    const byClass = new Map<string, ClassApprovalRates>();

    for (const group of groups) {
      const bucket =
        byClass.get(group.actionClass) ?? emptyRates(group.actionClass);
      byClass.set(group.actionClass, bucket);

      const count = group._count._all;

      switch (group.status) {
        case 'approved':
          if (group.decidedVia === 'human') bucket.approved += count;
          else bucket.grantAuthorized += count;
          break;
        case 'denied':
          // A `denied` row is always human — nothing else writes that status.
          // Guarded anyway so a future writer cannot quietly inflate the
          // denominator.
          if (group.decidedVia === 'human') bucket.denied += count;
          break;
        case 'auto_approved':
          bucket.autoApproved += count;
          break;
        case 'auto_denied':
          bucket.autoDenied += count;
          break;
        case 'pending':
          bucket.pending += count;
          break;
        case 'parked':
          bucket.parked += count;
          break;
        case 'superseded':
          bucket.superseded += count;
          break;
      }
    }

    return [...byClass.values()]
      .map((bucket) => {
        const humanDecisions = bucket.approved + bucket.denied;
        return {
          ...bucket,
          humanDecisions,
          // Null, not 0, when no human has weighed in. 0/0 is "no evidence",
          // and a 0% approval rate reads as "humans always reject this" —
          // which is the opposite claim.
          approvalRate:
            humanDecisions === 0 ? null : bucket.approved / humanDecisions,
        };
      })
      .sort((a, b) => a.actionClass.localeCompare(b.actionClass));
  }
}

function emptyRates(actionClass: string): ClassApprovalRates {
  return {
    actionClass,
    approved: 0,
    denied: 0,
    humanDecisions: 0,
    approvalRate: null,
    autoApproved: 0,
    autoDenied: 0,
    grantAuthorized: 0,
    pending: 0,
    parked: 0,
    superseded: 0,
  };
}

/**
 * The row shape `toView` needs, structurally.
 *
 * Structural rather than `Prisma.ApprovalRequestGetPayload`, matching
 * `TrustGrantRow`: a test double can satisfy it with plain numbers where
 * production supplies `Decimal`, which is what makes the service testable
 * without a database.
 */
export interface ApprovalRequestRow {
  id: string;
  actionClass: string;
  repositoryId: string;
  proposalId: string | null;
  targetKind: string | null;
  targetRef: string | null;
  summary: string;
  reasoning: string;
  blastRadius: string;
  effects: unknown;
  estimatedCostUsd: DecimalLike | number | null;
  timeoutPolicy: ApprovalTimeoutPolicy;
  timeoutAt: Date | null;
  status: ApprovalStatus;
  decidedAt: Date | null;
  decidedById: string | null;
  decidedVia: ApprovalDecidedVia | null;
  decisionNote: string | null;
  grantId: string | null;
  createdGrantId: string | null;
  escalationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toView(row: ApprovalRequestRow): ApprovalRequestView {
  return {
    id: row.id,
    actionClass: row.actionClass,
    repositoryId: row.repositoryId,
    proposalId: row.proposalId,
    targetKind: row.targetKind,
    targetRef: row.targetRef,
    summary: row.summary,
    reasoning: row.reasoning,
    blastRadius: row.blastRadius,
    // Stored as JSON and read back as JSON. Not re-validated against
    // `AutonomyEffect` here: the column is a FROZEN RECORD of what was
    // declared, and a historical row whose shape predates a widening of the
    // union is still the truth about what that action said it would do.
    effects: Array.isArray(row.effects)
      ? (row.effects as AutonomyEffect[])
      : [],
    estimatedCostUsd: toNumberOrNull(row.estimatedCostUsd),
    timeoutPolicy: row.timeoutPolicy,
    timeoutAt: row.timeoutAt?.toISOString() ?? null,
    status: row.status,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedById: row.decidedById,
    decidedVia: row.decidedVia,
    decisionNote: row.decisionNote,
    grantId: row.grantId,
    createdGrantId: row.createdGrantId,
    escalationId: row.escalationId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
