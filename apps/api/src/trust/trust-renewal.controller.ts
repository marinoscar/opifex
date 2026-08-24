import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import {
  RenewTrustGrantDto,
  RenewTrustGrantResultDto,
} from './dto/trust-renewal.dto';
import { TrustGrantService } from './trust-grant.service';

/**
 * One-tap trust-grant renewal (#115, epic #22, VISION §8).
 *
 * > Expiry — days or session. Renewal is one tap; silence revokes.
 *
 * #96 delivered the second clause: `authorize` filters on `expiresAt > now`,
 * so a lapsed grant stops authorizing immediately with no grace period. This
 * controller is the first clause. Without it expiry is pure friction — every
 * grant dies on schedule and the operator re-approves from scratch — and the
 * pressure VISION §8 opens by naming ("operators grant blanket trust out of
 * friction, not conviction") comes back through the only door left, which is
 * somebody quietly widening `DEFAULT_GRANT_EXPIRY_DAYS`.
 *
 * ## Why this is its own controller
 *
 * #101 owns the general trust surface — listing grants, revoking, the cockpit
 * read models — and is being built in parallel. A renewal endpoint added to
 * that controller would collide across a whole file; here the merge is one
 * small, obvious conflict in the module's `controllers` array. This file is
 * expected to fold into #101's controller once both have landed, and nothing
 * about it should be treated as a permanent boundary.
 *
 * ## `trust:grant`, because a renewal IS a grant
 *
 * Not `trust:renew`, and not a read permission with a write flag. A renewal
 * writes a new row that authorizes unattended execution for another fourteen
 * days, with the renewing user's name on `grantedById`. That is the same
 * authority "Always approve this class" exercises, which is why
 * `ApprovalsController` refuses that flag outright without this permission. A
 * separate, weaker renewal permission would be a path to holding trust
 * indefinitely without ever being allowed to grant it, and the chain would
 * make it look like the original granter's ongoing decision.
 *
 * ## The notification that brings an operator here carries NO authority
 *
 * The renewal prompt deep-links to the cockpit and nothing else. The same
 * argument `ApprovalsController` makes at length applies unchanged: a
 * notification is delivered to a DEVICE, not to a person — lock screens,
 * watches, push-service logs, fallback webhooks — and a capability token in
 * one of those would produce a grant attributed to whoever held the phone.
 */
@ApiTags('Trust')
@Controller('trust/grants')
export class TrustRenewalController {
  constructor(private readonly grants: TrustGrantService) {}

  @Post(':id/renew')
  @Auth({ permissions: [PERMISSIONS.TRUST_GRANT] })
  @ApiOperation({
    summary: 'Renew a trust grant. VISION §8\'s "renewal is one tap"',
    description:
      'Ends this grant with `endReason: "superseded_by_renewal"` and issues a successor, in ONE ' +
      'transaction — there is never a moment when both are live or neither is. The successor ' +
      'has the SAME SCOPE, always: `actionClass` and `repositoryId` are read off the old row and ' +
      'this endpoint takes no input that could change either. Its expiry, budget ceiling and ' +
      'auto-revoke thresholds are taken FRESH from the system defaults and then narrowed by the ' +
      "old grant's own terms, attribute by attribute — never widened. Copying the old terms " +
      'forward would let a grant created once with generous attributes carry them indefinitely, ' +
      'so a renewal chain would launder a one-time decision into a permanent one. The budget ' +
      'counters start at zero: a renewal is a fresh decision by a named human who has just been ' +
      'shown what the last period cost, and the previous spend is preserved on the old row. ' +
      '`grantedById` on the successor is YOU, not the original granter — the person renewing ' +
      'takes responsibility now. `renewedFromId` points back, so a widening across a chain of ' +
      'renewals is detectable after the fact. THERE IS NO GRACE PERIOD: a grant whose ' +
      '`expiresAt` has already passed cannot be renewed, not even by a millisecond, because a ' +
      'lapsed grant that could be revived by whoever noticed first would make "silence revokes" ' +
      'advisory. That case is a new grant decision, not a renewal. Both rows come back so the ' +
      'caller can show the chain.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(RenewTrustGrantResultDto, {
    status: 201,
    description:
      'The successor grant and the grant it replaced. `renewed.renewedFromId === ended.id`.',
  })
  @ApiResponse({ status: 404, description: 'No trust grant with that id' })
  @ApiResponse({
    status: 409,
    description:
      'The grant cannot be renewed, and NOTHING was written. `details.reason` says which of the ' +
      "four cases it is, because the operator's next move differs completely per case: " +
      "`expired` (it already lapsed — VISION §8's silence took effect; make a new grant), " +
      '`revoked` (a human deliberately ended it; renewing would silently undo their decision), ' +
      '`suspended` (the system ended it on evidence, and `details.endDetail` names the numbers ' +
      '— disagree by creating a new grant, which records that you looked and granted anyway), ' +
      'or `class-ineligible` (the action class is no longer autonomy-eligible, so no grant may ' +
      'authorize it at all). `details.expiresAt`, `details.status` and `details.endDetail` carry ' +
      'the evidence for the sentence.',
  })
  async renew(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RenewTrustGrantDto,
    @CurrentUser('id') userId: string,
  ) {
    // Note is the ONLY thing that crosses this boundary from the client. Every
    // other field on the successor is derived — from the old row (scope) or
    // from `defaults.ts` narrowed by the old row (the four attributes) — and
    // that absence is what enforces "no renewal path can extend scope". A
    // parameter that does not exist cannot be widened by a later `where`
    // clause getting relaxed.
    return this.grants.renew(id, userId, body.note ?? null);
  }
}
