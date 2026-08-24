import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { getActionClass } from '../supervisor/action-classes';
import { ApprovalGateService } from './approval-gate.service';
import {
  ApprovalDetailDto,
  ApprovalDto,
  ApprovalRatesQueryDto,
  ClassApprovalRatesDto,
  DecideApprovalDto,
  DecideResultDto,
  ListApprovalsQueryDto,
} from './dto/approval.dto';

/**
 * One tap from a phone (#98, epic #22, VISION §8).
 *
 * VISION §8's argument is that approvals must be CHEAP or trust becomes
 * meaningless: "operators grant blanket trust out of friction, not
 * conviction," and an approval that arrives as a 2am email read at 9am gets
 * blanket-approved within a week, "chosen while annoyed rather than while
 * thinking." So this surface exists to make one decision answerable in one
 * tap, with the four things §8 requires be present to decide — what, why,
 * blast radius, and what happens if ignored — already on the screen.
 *
 * ## There is no capability token on the decide endpoint, and that is the point
 *
 * The obvious design is the one this deliberately does not use: mint an
 * unguessable token, put it in the notification, and let a tap on the
 * notification approve the action. It is the single most tempting shortcut
 * here, because it is the only way to make the tap literally one tap.
 *
 * #98 rules it out in two sentences: "approval is authenticated; a notification
 * alone cannot authorize", and "reuse the existing auth rather than inventing a
 * token scheme". Both halves matter. A notification is delivered to a device,
 * not to a person — it lands on a lock screen, it is mirrored to a watch, it
 * survives in a push service's logs, and it is forwarded by a fallback webhook
 * to whatever third party the operator configured. Every one of those is a
 * place a bearer credential would come to rest. An approval carries the
 * authority to spend money and to change a repository, and VISION §8's whole
 * trust model rests on a human decision being attributable to a human: an
 * `ApprovalRequest` records `decidedById` because, as `RaiseApprovalInput` puts
 * it, "an approval with no approver is not evidence." A token that anyone
 * holding the notification could redeem produces an approval attributed to
 * whoever held the phone, which #99's promotion ladder would then read as
 * evidence that a person endorsed the class.
 *
 * So the notification carries a deep link and NO AUTHORITY. Tapping it opens
 * the cockpit; the cockpit's existing session, with `approvals:decide`, is what
 * authorizes. In practice that is one tap on an already-signed-in phone and two
 * when the session has lapsed, and the second tap is the price of the property.
 *
 * The `receiptId` on an escalation notification is NOT a counter-example and
 * must not be reused here. It is a DELIVERY RECEIPT: the only thing it
 * authorizes is asserting "a device displayed this", which is why a service
 * worker with no session may post it. It exists because Web Push gives no
 * delivery guarantee and #58 refuses to let "we tried to tell you" look like
 * "somebody was told". Widening it into a decision credential would convert a
 * proof-of-delivery into a proof-of-consent — two claims that a lock screen
 * cannot distinguish between, since a phone displaying a notification says
 * nothing about whether its owner read it, let alone agreed.
 *
 * ## Never-trustable actions never reach this surface
 *
 * ADR-0013's forbidden effects — force-push, protected-branch writes,
 * destructive deletes, credential access, self-modification of the policy
 * table or CI, spend above the hard ceiling — cannot appear in this queue, and
 * NOT because anything here filters them out. They are refused at
 * `ApprovalGateService.gate` rule 0, before grants are consulted and before any
 * row is written, so there is no `ApprovalRequest` for them to be listed from.
 *
 * The filtering alternative is worse in a way that is easy to miss. A row that
 * existed and were hidden would be one query change away from being visible and
 * one tap away from being approved — and approving it would still change
 * nothing, because #95 refuses the effects again at the execution boundary.
 * The operator would have been shown a question that cannot be answered, which
 * is exactly the approval fatigue VISION §8 exists to remove, and an `approved`
 * row for a never-trustable action would sit in #99's numerator as evidence
 * that humans endorse a class of action the system will never perform. VISION
 * §8's phrase is "regardless of any grant"; a rule enforced by the absence of a
 * row survives a refactor of this file, and one enforced by a `where` clause
 * does not.
 *
 * The refusal is not lost: it is an `autonomy.refused` audit row naming every
 * matched rule, which is where a misbehaving proposer shows up as a pattern
 * rather than as one dismissed notification.
 *
 * ## Two permissions, and a third for the flag
 *
 * `approvals:read` and `approvals:decide` are separate for the reason
 * `escalations:acknowledge` is separate from `escalations:read`: a verdict is
 * not an observation. `trust:grant` is separate again, and its composition with
 * `alwaysApproveThisClass` is enforced HERE — see `decide`.
 */
@ApiTags('Approvals')
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly gate: ApprovalGateService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.APPROVALS_READ] })
  @ApiOperation({
    summary: 'The approval queue: everything still waiting on a person',
    description:
      'Both open statuses. `parked` is NOT a resolution — it is `pending` with no timer — and a ' +
      'queue that hid it would hide precisely the requests that wait forever if nobody looks. ' +
      'Ordered OLDEST FIRST: the oldest is the one that has been ignored longest, which is the ' +
      'ordering the queue exists to surface. Read `timeoutPolicy` and `timeoutAt` together: a ' +
      'null `timeoutAt` means there is no timer at all, so do not render a countdown for it. ' +
      'Never-trustable actions (ADR-0013) never appear here, and not because this endpoint ' +
      'filters them — they are refused before an approval row is ever written.',
  })
  @ApiQuery({ name: 'repositoryId', required: false, type: String })
  @ApiQuery({ name: 'actionClass', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'parked'],
    description:
      'Narrows to one of the two open statuses. It cannot widen the queue to a decided row.',
  })
  @ApiDataResponse(ApprovalDto, {
    isArray: true,
    description: 'Open approval requests, oldest first',
  })
  async list(@Query() query: ListApprovalsQueryDto) {
    return this.gate.listPending({
      ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
      ...(query.actionClass ? { actionClass: query.actionClass } : {}),
      ...(query.status ? { status: query.status } : {}),
    });
  }

  /**
   * Declared BEFORE `:id`, and it has to be.
   *
   * Nest matches routes in declaration order, so a `GET /approvals/:id` above
   * this one would swallow `/approvals/rates` and answer 400 from the UUID
   * pipe — an error that says nothing about the real cause.
   */
  @Get('rates')
  @Auth({ permissions: [PERMISSIONS.APPROVALS_READ] })
  @ApiOperation({
    summary: 'Per action class, how often a human approves it',
    description:
      'The evidence the promotion ladder is built on. The buckets are separate and must NEVER ' +
      'be summed: `autoApproved` is SILENCE, not agreement, and folding it into `approved` ' +
      'would let a class promote itself by being ignored — nobody is ever asked, everything ' +
      'times out, and the rate reads 100% over a population of zero human opinions. ' +
      '`autoDenied` is excluded from the denominator on the mirror argument, and ' +
      '`grantAuthorized` because it is machine action taken on evidence a human supplied ' +
      'earlier: counting it would let one grant re-attest to the trust that created it. ' +
      '`approvalRate` is null, never 0, when no human has decided one — 0/0 is "no evidence", ' +
      'and 0% says the opposite. Only classes with at least one row in the window appear.',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description: 'Window in days, 1–180. Defaults to 30.',
  })
  @ApiDataResponse(ClassApprovalRatesDto, {
    isArray: true,
    description: 'Approval evidence per action class, by class id',
  })
  async rates(@Query() query: ApprovalRatesQueryDto) {
    return this.gate.approvalRatesByClass(query.days);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.APPROVALS_READ] })
  @ApiOperation({
    summary: 'One approval, with everything needed to decide from a phone',
    description:
      'VISION §8 requires "enough context to decide — what, why, blast radius, and what happens ' +
      'if ignored", and this is the endpoint that has to satisfy it: `summary`, `reasoning`, ' +
      '`blastRadius`, and `timeoutPolicy` + `timeoutAt` respectively. `effects` is the machine- ' +
      'readable declaration of everything the action would do, frozen at raise time, so a ' +
      'historical approval is auditable against what the action would actually have done rather ' +
      'than against the label it carried. `actionClassEntry` carries the registry `definition` ' +
      '— a sentence, not a category label — because an operator who has to already know what ' +
      '`re-dispatch` means does not have enough context, they have a label. It is null when the ' +
      'registry does not recognise the class, which is not a defensive case: an unknown class ' +
      'parks, so a parked approval with a null entry means the proposer and the registry have ' +
      'drifted, NOT that an irreversible action awaits judgment (ADR-0014).',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(ApprovalDetailDto, { description: 'The approval request' })
  @ApiResponse({ status: 404, description: 'Approval request not found' })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const approval = await this.gate.get(id);

    // Joined here rather than stored on the row, exactly as
    // `GET /supervisor/approval-rates` joins the same registry: these facts
    // describe the CLASS, and a copy in the database is the drift ADR-0011 put
    // the taxonomy in one file to prevent. `getActionClass` returns undefined
    // for an unrecognised id; normalised to null so the field is present in
    // JSON rather than silently missing, which a client cannot distinguish
    // from a field it forgot to read.
    return {
      ...approval,
      actionClassEntry: getActionClass(approval.actionClass) ?? null,
    };
  }

  @Post(':id/decide')
  @Auth({ permissions: [PERMISSIONS.APPROVALS_DECIDE] })
  @ApiOperation({
    summary: 'Approve or deny. VISION §8\'s "one tap from a phone"',
    description:
      'Authenticated with the ordinary session — the notification that brought you here carries ' +
      "no authority of its own, deliberately. `alwaysApproveThisClass` is VISION §8's third " +
      'option and requires `trust:grant` IN ADDITION to `approvals:decide`; without it the ' +
      'whole request is refused with 403 and the single decision is NOT applied, because the ' +
      'operator tapped one button meaning "approve this AND stop asking me" and doing half of ' +
      'it silently is how somebody comes to believe they hold a grant that does not exist. ' +
      'Even with the permission the grant is minted only for an autonomy-eligible class, and ' +
      'its four attributes (scope, expiry, budget ceiling, auto-revoke) are attached ' +
      'automatically — there is no widening path from this flag. Whenever the flag was set and ' +
      'no grant resulted, `grantSkippedReason` says why in a sentence: SHOW IT. ' +
      '`decidedAfterTimeout` means the verdict counted but the window had already lapsed.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(DecideResultDto, { description: 'The recorded decision' })
  @ApiResponse({ status: 404, description: 'Approval request not found' })
  @ApiResponse({
    status: 403,
    description:
      '`alwaysApproveThisClass` was set by a caller without `trust:grant`. NOTHING was ' +
      'recorded — the approval is still open and can be decided without the flag. ' +
      '`details.reason` is `trust-grant-required`.',
  })
  @ApiResponse({
    status: 409,
    description:
      'The request is no longer open. `details.reason` says WHICH — `already-decided-by-human`, ' +
      '`already-timed-out`, `already-authorized-by-grant` or `superseded` — because a generic ' +
      'conflict cannot distinguish "somebody else answered this" from "the clock answered it ' +
      'while you were typing", and those call for completely different things from the ' +
      'operator. `details.decidedAt`, `details.decidedById` and `details.decidedVia` name the ' +
      'moment and, where there is one, the actor.',
  })
  async decide(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecideApprovalDto,
    @CurrentUser() user: RequestUser,
  ) {
    // ---- The permission composition, which only this layer can make --------
    //
    // `ApprovalGateService` has no view of the caller's permissions and should
    // not acquire one — a service that could read the RBAC table would be a
    // service that could be called from a cron task with an implied identity.
    // So the controller is the ONLY place `approvals:decide` + `trust:grant`
    // can be composed, and `DecideApprovalInput` says so at the flag's
    // definition.
    //
    // ## Why the whole request is refused, and not just the flag
    //
    // The tempting alternative is to approve the action and quietly drop the
    // grant — the verdict is the part that was hard to obtain, after all, and
    // `grantSkippedReason` already exists to report a flag that did nothing.
    // It loses, and the reason is what the operator MEANT. "Always approve this
    // class" is a single tap expressing a single intention: approve this AND
    // stop asking me. Granting the first half tells them their intention
    // landed; they stop watching the class, and every later request of it is
    // then approved by a TIMEOUT rather than by the grant they think they
    // created — which for most autonomy-eligible classes means denied by
    // silence (ADR-0014), so the work quietly stops instead. VISION §8's whole
    // argument is that a trust decision must be made "while thinking", and a
    // decision the operator believes they made and did not is the worst
    // possible version of that.
    //
    // Refusing both is recoverable in one obvious step: the approval is
    // untouched and still open, and the same person can decide it again
    // without the flag, or ask an admin. Nothing is lost but a tap.
    if (
      body.alwaysApproveThisClass === true &&
      !user.permissions.includes(PERMISSIONS.TRUST_GRANT)
    ) {
      throw new ForbiddenException({
        code: 'TRUST_GRANT_REQUIRED',
        message:
          `Your decision on approval ${id} was NOT applied. ` +
          '"Always approve this class" mints a trust grant, which requires ' +
          `the "${PERMISSIONS.TRUST_GRANT}" permission (admin) in addition ` +
          `to "${PERMISSIONS.APPROVALS_DECIDE}", and your account does not ` +
          'have it. Nothing was recorded: the request is still open. Decide ' +
          'it again without "always approve this class" to record the single ' +
          'verdict, or ask an administrator to create the grant. It was ' +
          'refused whole rather than half-applied because approving the one ' +
          'action while silently dropping the grant would leave you believing ' +
          'you hold trust you do not, and you would stop watching a class ' +
          'nobody promoted.',
        details: {
          // `HttpExceptionFilter` overwrites the envelope's `code` from the
          // status, so the discriminator the cockpit branches on has to travel
          // in `details.reason` — the same place
          // `ApprovalNotPendingException` puts its own.
          reason: 'trust-grant-required',
          approvalId: id,
          requiredPermission: PERMISSIONS.TRUST_GRANT,
          /** Explicit, so a client never has to infer it from the status. */
          decisionApplied: false,
        },
      });
    }

    return this.gate.decide(id, {
      decision: body.decision,
      actorUserId: user.id,
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(body.alwaysApproveThisClass !== undefined
        ? { alwaysApproveThisClass: body.alwaysApproveThisClass }
        : {}),
    });
  }
}
