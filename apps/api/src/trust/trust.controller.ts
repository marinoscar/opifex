import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import {
  type ActionClassId,
  getActionClass,
} from '../supervisor/action-classes';
import {
  DEFAULT_GRANT_BUDGET_CEILING_USD,
  DEFAULT_GRANT_EXPIRY_DAYS,
  DEFAULT_GRANT_MAX_COST_PER_ACTION_USD,
  DEFAULT_GRANT_MAX_FAILURE_RATE,
  defaultGrantAttributes,
} from './defaults';
import {
  CreateTrustGrantDto,
  ListTrustGrantsQueryDto,
  RevokeTrustGrantDto,
  TrustGrantDetailDto,
  TrustGrantDto,
  TrustGrantListItemDto,
} from './dto/trust-grant.dto';
import { TrustGrantService } from './trust-grant.service';

/**
 * The trust-grant surface (#101, epic #22, VISION §8).
 *
 * ## The four attributes are not caller input, and that is the whole design
 *
 * VISION §8 does not say grants MAY carry a scope, an expiry, a budget ceiling
 * and auto-revoke thresholds. It says they carry all four, "attached
 * automatically", and that the one-tap path is safe BY CONSTRUCTION. That is a
 * claim about code, and this controller is where it is either true or quietly
 * false: `POST /trust/grants` accepts an action class, a repository and a
 * note, and nothing else. The rest comes from `defaultGrantAttributes()`.
 *
 * A caller who could set `expiresAt` could set it to 3650 days, and the
 * mechanism would still LOOK intact — every row would still carry an expiry,
 * every list would still show one, and nothing would ever revoke itself. That
 * is strictly worse than having no expiry at all, because the screen would
 * still say the grant was bounded. The same argument applies to the ceiling
 * ("the grant dies at a cumulative spend" — a $10,000 ceiling never dies) and
 * to the two auto-revoke thresholds (a failure-rate limit of 1.0 never fires).
 *
 * So the create schema is `.strict()`: sending any of the four is a 400 naming
 * the field, not a silently-ignored key. Ignoring them would be the worse
 * failure of the two — a client that sent `budgetCeilingUsd: 500` and received
 * a 201 would have to read the response body to discover its ceiling is $25,
 * and nobody reads a 201. The operator ends up believing they hold trust they
 * do not, which is exactly what `ApprovalsController.decide` refuses whole
 * rather than half-applying.
 *
 * The wider grant is still reachable — `TrustGrantService.create` takes all
 * four explicitly, so a cron task or a future admin path can record the
 * numbers somebody deliberately chose. What no HTTP caller can do is make the
 * WIDE grant the one the fast path hands out.
 *
 * ## Why there is no PATCH
 *
 * For the same reason. An "extend this grant" endpoint is `expiresAt` as
 * caller input wearing a different verb, and a "raise the ceiling" endpoint is
 * the blank check by instalments. Renewal is a NEW grant with
 * `renewedFromId` set (#115), which leaves the original row saying exactly
 * what it originally said — the audit trail VISION §8's digest is read from.
 * Widening in place would rewrite history to match the present.
 *
 * ## Three permissions, not one
 *
 * `trust:read`, `trust:grant` and `trust:revoke` are separate because they are
 * different acts. Reading which grants exist is something anyone operating the
 * factory needs; creating one extends authority to a machine; revoking one
 * takes it back. Note that revoke is deliberately NOT folded into `trust:grant`
 * — narrowing authority is always the safe direction, and an operator who can
 * see a grant misbehaving must never be blocked from stopping it because the
 * permission that stops it is the same one that creates it.
 *
 * ## What this controller cannot do
 *
 * Execute anything. `TrustModule` imports `PrismaModule` and nothing else, so
 * the module that decides whether something may run unattended has no path to
 * running it. VISION §8: "An agent that can edit the check enforcing its own
 * trailers, or grant itself trust, has the appearance of guardrails and none
 * of the substance."
 */
@ApiTags('Trust')
@Controller('trust')
export class TrustController {
  constructor(private readonly grants: TrustGrantService) {}

  @Get('grants')
  @Auth({ permissions: [PERMISSIONS.TRUST_READ] })
  @ApiOperation({
    summary:
      'Trust grants: what may currently run unattended, and on what terms',
    description:
      'Newest first. Every row carries all four VISION §8 attributes — scope (`actionClass` + ' +
      '`repositoryId`), `expiresAt`, `budgetCeilingUsd`, and the auto-revoke thresholds ' +
      '(`maxFailureRate`, `maxCostPerActionUsd`, `minActionsBeforeAutoRevoke`) — plus the usage ' +
      'measured against them (`spentUsd`, `actionsAuthorized`, `actionsFailed`) and the derived ' +
      'headroom fields the cockpit renders: `remainingBudgetUsd`, `budgetHeadroomFraction`, ' +
      '`msUntilExpiry`, `failureRate`, `nearExpiry`, `nearBudget`. Those are computed ' +
      'server-side on purpose: two independent versions of `remaining / ceiling` is how a ' +
      'renewal banner and a budget bar end up disagreeing on one screen. Read `msUntilExpiry` ' +
      'as SIGNED — it goes negative after a grant lapses, because "expired 3 hours ago" and ' +
      '"expires in 0ms" are different facts. Read `failureRate` as NULLABLE — null is "no ' +
      'actions yet", never 0%. DEFAULTS TO ACTIVE GRANTS ONLY: pass `includeEnded=true` for the ' +
      'revoked, expired and suspended ones, which are never deleted because the record of what ' +
      'was trusted and why it stopped being trusted is the evidence the promotion ladder and ' +
      'the daily digest are made of. An explicit `status` filter wins over `includeEnded`. Each ' +
      'row also carries `actionClassTitle`, the ADR-0011 registry title, null — never the raw ' +
      'id — when the registry does not know the class.',
  })
  @ApiQuery({ name: 'repositoryId', required: false, type: String })
  @ApiQuery({ name: 'actionClass', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['active', 'expired', 'revoked', 'suspended'],
    description:
      'Exactly one status. OVERRIDES `includeEnded`, so `status=revoked` returns revoked ' +
      'grants whether or not the flag is set — a filter that returned nothing because of a ' +
      'default the caller did not set would be a filter that lies.',
  })
  @ApiQuery({
    name: 'includeEnded',
    required: false,
    type: Boolean,
    description:
      'Include revoked, expired and suspended grants. Defaults to false: the common read is ' +
      '"what may run unattended right now".',
  })
  @ApiDataResponse(TrustGrantListItemDto, {
    isArray: true,
    description: 'Trust grants, newest first',
  })
  async list(@Query() query: ListTrustGrantsQueryDto) {
    const rows = await this.grants.list({
      ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
      ...(query.actionClass ? { actionClass: query.actionClass } : {}),
      ...(query.status ? { status: query.status } : {}),
      includeEnded: query.includeEnded,
    });

    // The registry join happens here rather than in the browser, narrowed to
    // the ONE field a list row needs: a second copy of the ADR-0011 taxonomy
    // in a client is the drift that file exists to prevent, and the rest of
    // the entry (definition, reversibility, eligibility) is decision context
    // that belongs on the detail screen where the decision is made.
    //
    // NO FALLBACK TO THE RAW ID. An unknown class yields null and the client
    // renders `actionClassTitle ?? actionClass` itself. Substituting the id
    // server-side would make registry drift invisible — and drift is a real
    // case here rather than a defensive one, because a grant outlives edits to
    // the taxonomy.
    return rows.map((row) => ({
      ...row,
      actionClassTitle: getActionClass(row.actionClass)?.title ?? null,
    }));
  }

  @Get('grants/:id')
  @Auth({ permissions: [PERMISSIONS.TRUST_READ] })
  @ApiOperation({
    summary: 'One grant, with its class definition and its renewal chain',
    description:
      'Everything the list returns, plus two joins. `actionClassEntry` is the ADR-0011 registry ' +
      'entry — `title`, `definition`, `effect`, `reversibility`, `autonomyEligible` — so an ' +
      'operator deciding whether to revoke can see WHAT they would be switching off rather than ' +
      'a class id. It is null when the registry does not recognise the class, which is not a ' +
      'defensive case: a grant outlives edits to the taxonomy, and a live grant for a class the ' +
      'registry has since dropped is precisely the drift worth seeing. `autonomyEligible: ' +
      'false` on a live grant means the same thing and is reported rather than hidden — the ' +
      'grant could not have been created today. The renewal chain travels in both directions: ' +
      '`renewedFromId` is the grant this one replaced, and `renewedBy` is the list of grants ' +
      'issued to replace THIS one, newest first. Both halves are needed on one screen, because ' +
      'an expired grant with a renewal is a grant somebody kept alive and an expired grant ' +
      'without one is "silence revokes" having actually happened — and the backward edge alone ' +
      'cannot tell them apart.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(TrustGrantDetailDto, { description: 'The trust grant' })
  @ApiResponse({ status: 404, description: 'No grant with that id' })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const grant = await this.grants.get(id);
    const renewedBy = await this.grants.renewalsOf(id);

    return {
      ...grant,
      // Normalised to null rather than left undefined, so the field is present
      // in the JSON: a client cannot distinguish a missing key from a key it
      // forgot to read.
      actionClassEntry: getActionClass(grant.actionClass) ?? null,
      renewedBy,
    };
  }

  @Post('grants')
  @Auth({ permissions: [PERMISSIONS.TRUST_GRANT] })
  @ApiOperation({
    summary:
      'Grant trust for one class in one repository. THREE FIELDS, and the omissions are the point',
    description:
      'The body accepts `actionClass`, `repositoryId` and an optional `note`. IT ACCEPTS ' +
      'NOTHING ELSE, and in particular it does NOT accept `expiresAt`, `budgetCeilingUsd`, ' +
      '`maxFailureRate`, `maxCostPerActionUsd` or `minActionsBeforeAutoRevoke`. Sending any of ' +
      'them is a 400 naming the field. VISION §8 requires that every grant carry scope, expiry, ' +
      'a budget ceiling and auto-revoke thresholds "attached automatically" — safe by ' +
      "construction, not by the caller's restraint — so this endpoint attaches them from " +
      `\`defaultGrantAttributes()\`: ${DEFAULT_GRANT_EXPIRY_DAYS} days, ` +
      `$${DEFAULT_GRANT_BUDGET_CEILING_USD} cumulative, a ` +
      `${Math.round(DEFAULT_GRANT_MAX_FAILURE_RATE * 100)}% failure-rate ceiling and a ` +
      `$${DEFAULT_GRANT_MAX_COST_PER_ACTION_USD} per-action ceiling, with the rate rules held ` +
      'until a minimum sample has accrued. A caller able to set the expiry could set it to ten ' +
      'years, and the mechanism would still LOOK intact on every screen while revoking nothing ' +
      '— which is worse than having no expiry at all. The unknown key is REFUSED rather than ' +
      'ignored because a 201 nobody reads, over a grant whose real ceiling is a twentieth of ' +
      'the one requested, leaves the operator believing they hold trust they do not. There is ' +
      'no PATCH for the same reason: renewal is a new grant with `renewedFromId` set, which ' +
      'leaves the original row saying what it originally said.',
  })
  @ApiDataResponse(TrustGrantDto, {
    status: 201,
    description: 'The created grant, with the four attributes already attached',
  })
  @ApiResponse({
    status: 400,
    description:
      'The class is unknown or not autonomy-eligible (a class the registry marks ineligible ' +
      'can NEVER hold a grant, whatever its record — VISION §7 ranks quarantine decisions ' +
      '"probably never" and §8 puts clearing quarantine on the never-trustable list), or the ' +
      'body carried one of the four automatic attributes.',
  })
  @ApiResponse({
    status: 404,
    description:
      'No such repository. A grant is scoped to an action class IN A REPOSITORY; there is no ' +
      '"all repositories" value, because VISION §8 is explicit that it is never "trust the ' +
      'agent".',
  })
  async create(
    @Body() body: CreateTrustGrantDto,
    @CurrentUser('id') userId: string,
  ) {
    // The four attributes, attached here and nowhere else on this path. One
    // function, one set of numbers — `defaults.ts` argues that a per-caller
    // assembly is how the third tap ends up safe wherever somebody remembered
    // and unbounded wherever they did not.
    const attributes = defaultGrantAttributes(new Date());

    return this.grants.create({
      // Cast, not re-validated. The zod enum above is built FROM
      // `ACTION_CLASS_IDS`, so the value is an `ActionClassId` by the time it
      // gets here; the cast is only because the enum is widened to `string` to
      // keep the DTO from depending on the tuple's exact literal type. The
      // service checks `isActionClass` again regardless.
      actionClass: body.actionClass as ActionClassId,
      repositoryId: body.repositoryId,
      // The provenance edge VISION §5 requires: a grant with no grantor is not
      // evidence that anybody extended trust. Taken from the authenticated
      // session, never from the body — a caller-supplied `grantedById` would
      // let one operator's authority be recorded against another's name.
      grantedById: userId,
      ...attributes,
      ...(body.note !== undefined ? { note: body.note } : {}),
    });
  }

  @Delete('grants/:id')
  @Auth({ permissions: [PERMISSIONS.TRUST_REVOKE] })
  @ApiOperation({
    summary:
      'Revoke a grant. Immediate, permanent, and returns the ended grant',
    description:
      'Takes effect at once: the row moves to `revoked` with `endReason: manual_revocation` and ' +
      '`revokedById` set to the caller, and `TrustGrantService.authorize` stops matching it on ' +
      'the very next call. There is no grace period and no undo — a revoked grant is never ' +
      'reactivated, because a decision the system could quietly reverse is not a decision. To ' +
      'restore trust, issue a new grant, which re-attaches all four attributes and records who ' +
      'chose to trust the class again. Note the deliberate asymmetry with `suspended`: a ' +
      "suspension is the system's opinion on evidence and a human may disagree with it, a " +
      'revocation is a human decision. The optional `note` is appended to `endDetail`, the ' +
      'sentence the next operator reads when they find the grant dead. A body is optional ' +
      'entirely — revocation is the safe direction and must never be harder than granting. The ' +
      'ENDED grant is returned rather than 204, so the caller can render the terminal state ' +
      'without a follow-up read that would race the next sweep.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  // Documented as OPTIONAL, matching the schema's default. Nest marks every
  // `@Body()` required, which would tell a generated client it must send one —
  // and a DELETE frequently carries none.
  @ApiBody({ type: RevokeTrustGrantDto, required: false })
  @ApiDataResponse(TrustGrantDto, {
    description: 'The grant, as it now stands: revoked',
  })
  @ApiResponse({ status: 404, description: 'No grant with that id' })
  @ApiResponse({
    status: 409,
    description:
      'The grant had already ended. NOTHING was changed and the existing end stands — a second ' +
      'revocation must not overwrite the reason the grant actually died, because "revoked by ' +
      'Ana" replacing "suspended: failure rate 62% over 8 actions" would erase the only record ' +
      'of a class misbehaving. `details.reason` is `already-ended`, and `details.status`, ' +
      '`details.endReason` and `details.endedAt` say how it ended.',
  })
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RevokeTrustGrantDto,
    @CurrentUser('id') userId: string,
  ) {
    // Read first, so a missing grant is a 404 naming the id rather than a 409
    // about a row that never existed.
    const before = await this.grants.get(id);

    const ended = await this.grants.revoke(id, userId, body.note ?? null);

    if (!ended) {
      // `revoke` is a conditional `updateMany` on `status: 'active'`, so a
      // false here means the grant was already over — either it was ended
      // between the read above and the write, or it was never active. Either
      // way the existing end reason is left exactly as it was: overwriting it
      // would destroy the record of WHY autonomy stopped, which is the fact
      // the digest and the promotion ladder are read from.
      throw new ConflictException({
        code: 'TRUST_GRANT_ALREADY_ENDED',
        message:
          `Trust grant ${id} is already ${before.status} and was not changed. ` +
          (before.endDetail ??
            'It ended before this request reached the server.') +
          ' The original end reason is preserved deliberately: a second ' +
          'revocation that overwrote it would erase the record of why ' +
          'autonomy stopped. Nothing further is required — the grant ' +
          'authorizes nothing.',
        details: {
          // `HttpExceptionFilter` derives the envelope's `code` from the
          // status, so the discriminator a client branches on has to travel in
          // `details.reason` — the same place the approvals conflict puts its
          // own.
          reason: 'already-ended',
          grantId: id,
          status: before.status,
          endReason: before.endReason,
          endedAt: before.endedAt,
        },
      });
    }

    // Re-read rather than reconstructing the ended view in this handler. The
    // row is the authority on `endedAt` and `endDetail`, and a hand-built copy
    // would be a second version of the sentence the service already wrote.
    return this.grants.get(id);
  }
}
