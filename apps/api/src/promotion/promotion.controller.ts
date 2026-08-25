import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import {
  DemoteClassDto,
  ManualDemotionResultDto,
  PromotionLadderDto,
  PromotionStateDetailDto,
} from './dto/promotion.dto';
import { LADDER_THRESHOLDS, PromotionService } from './promotion.service';

/**
 * The promotion ladder, as an operator reads it (#101, epic #22, VISION §7).
 *
 * ## There is no promote endpoint, and there is not going to be one
 *
 * VISION §7 rung 3 is "auto-execute the classes with a DEMONSTRATED RECORD",
 * and rung 4 is "automatic on regression, NOT A JUDGMENT CALL". A
 * `POST /promotion/states/:class/promote` would be exactly the judgement call
 * those two sentences exist to eliminate: autonomy extended on somebody's
 * confidence rather than on evidence, at the moment they are most impatient
 * with the approval queue. The whole ladder is a machine for making that
 * decision boring and legible, and a manual override is a way of skipping it
 * that would be used precisely on the classes the evidence was not ready to
 * promote.
 *
 * It would also corrupt the measurement itself. #99's numbers are the argument
 * for autonomy; a class promoted by hand carries a rung nothing supports, and
 * the frozen `evidenceJson` behind it would describe a decision that was not
 * made on evidence at all. `SupervisorModule` refuses an "apply this proposal"
 * endpoint for the same reason, in the same words: it would promote every
 * action class at once, bypassing the measurement the ladder is built on.
 *
 * The route from evidence to something actually running is unchanged and has a
 * human in it: the ladder promotes on evidence, promotion makes the class
 * ELIGIBLE for a grant, and a person taps "always approve this class" to mint
 * one. That tap is the only edge in the provenance graph that says a human
 * extended trust, and no endpoint here can forge it.
 *
 * ## Demotion MAY be manual, and the asymmetry is the argument
 *
 * `POST /promotion/states/:actionClass/demote` exists, gated on
 * `trust:revoke`. Narrowing authority is always safe: a hand-demotion cannot
 * make anything run that was not already running, and its worst case is work
 * queueing for a human who need not have been asked — delay, not damage. The
 * operator also holds evidence the ladder structurally cannot see: output that
 * is bad in ways an approval count does not capture, or an incident that has
 * not yet reached the 14-day regression window. Waiting a fortnight for the
 * window to notice is not a safety property.
 *
 * ## Why the read model reports the switch
 *
 * `PROMOTION_LADDER_ENABLED` defaults OFF, so on most deployments no rung has
 * moved or will. A cockpit showing rungs without saying so would present three
 * stale rows as live conclusions, which is why `enabled` is on every response
 * from this controller rather than on a separate settings call somebody might
 * not make.
 */
@ApiTags('Promotion')
@Controller('promotion')
export class PromotionController {
  constructor(private readonly promotion: PromotionService) {}

  @Get('states')
  @Auth({ permissions: [PERMISSIONS.TRUST_READ] })
  @ApiOperation({
    summary:
      'Every action class, its rung, its evidence, and what it would take to promote',
    description:
      'One row per registered action class, in registry order, whether or not the ladder has ' +
      'ever written a row for it — a class MISSING from a list is indistinguishable from a ' +
      'class nothing has ever proposed. Rows for classes that have left the registry are ' +
      'appended rather than hidden, because one of them may be standing on the promoted rung ' +
      'right now and a list that dropped it would report less autonomy than the system holds. ' +
      'Per class: `rung`, `eligible`, `currentEvidence.rate` (the approval rate — NULL, never ' +
      '0, when nobody has judged one), `currentEvidence.sample` (the sample size), and ' +
      '`requirement` — the sentence saying what is missing. `requirement` is the POLICY ' +
      "LAYER'S OWN text, produced by the same function the hourly evaluation uses, and it must " +
      'be rendered verbatim. Deriving "2 more needed" client-side from `thresholds` would be a ' +
      'second implementation of the rule that actually decides, and the day a threshold moves ' +
      'the screen would state a requirement that no longer applies; `thresholds` is published ' +
      'so a progress bar can be drawn WITHOUT parsing the sentence, not so the sentence can be ' +
      'recomputed. `wouldChange` says what the next evaluation would do — a forecast, and ' +
      'while `enabled` is false it is only that. READ `enabled` FIRST: it is ' +
      '`PROMOTION_LADDER_ENABLED`, it defaults off, and while it is false no rung will move, ' +
      'though every existing trust grant keeps working and keeps enforcing its own expiry, ' +
      'ceiling and auto-revoke. Note that `promoted` never means "running unattended": it ' +
      'means ELIGIBLE for a grant, and a promoted class with no grant runs nothing.',
  })
  @ApiDataResponse(PromotionLadderDto, {
    description: 'The ladder, plus whether it is switched on',
  })
  async states() {
    return this.promotion.ladder();
  }

  @Get('states/:actionClass')
  @Auth({ permissions: [PERMISSIONS.TRUST_READ] })
  @ApiOperation({
    summary:
      'One class, with the frozen evidence its last rung change was made from',
    description:
      'Everything the list carries for this class, plus the history the list omits: ' +
      '`evidence` (the `ClassEvidence` FROZEN at the last rung change, never refreshed), ' +
      '`changeReason`, `changeDetail`, `promotedAt`, `demotedAt` and `demotionCount`. Read ' +
      '`evidence` and `currentEvidence` as different claims and never swap them — the frozen ' +
      'one explains a decision that was already made, the live one describes the factory now. ' +
      '#99 requires promotion and demotion to state their evidence, and evidence that moved ' +
      'afterwards could not be checked against the decision, which is the only thing stating ' +
      'it was for. `demotionCount` counts demotions rather than rung changes: a class that ' +
      'oscillates is evidence about the THRESHOLDS rather than about the class. A registered ' +
      'class the ladder has never evaluated answers 200 at rung `observe` with null evidence — ' +
      '"the cron has not run" is not "the class does not exist".',
  })
  @ApiParam({
    name: 'actionClass',
    type: String,
    description: 'An ADR-0011 action class id, e.g. `re-dispatch`.',
  })
  @ApiDataResponse(PromotionStateDetailDto, {
    description: 'The class, its rung, and the evidence behind it',
  })
  @ApiResponse({
    status: 404,
    description:
      'The id is not in the registry AND no ladder row exists under it — a typo. A registered ' +
      'class with no row is NOT a 404; it is rung `observe`.',
  })
  async state(@Param('actionClass') actionClass: string) {
    const now = new Date();
    const state = await this.promotion.ladderStateFor(actionClass, now);

    // Composed here rather than in the service because it is presentation: the
    // service already owns `enabled`, and the only decision this makes is that
    // a deep link to one class must carry the same switch the list carries.
    return {
      enabled: this.promotion.enabled,
      readAt: now.toISOString(),
      thresholds: LADDER_THRESHOLDS,
      state,
    };
  }

  @Post('states/:actionClass/demote')
  @Auth({ permissions: [PERMISSIONS.TRUST_REVOKE] })
  @ApiOperation({
    summary:
      'Take autonomy back from a class by hand. There is deliberately no promote',
    description:
      'Demotes a promoted class immediately and SUSPENDS EVERY ACTIVE TRUST GRANT for it, ' +
      'exactly as an automatic demotion does. The suspension is the durable effect and the one ' +
      'that matters: nothing re-creates a suspended grant except a human tapping "always ' +
      'approve this class", so work of this class stops at the approval gate from this moment. ' +
      'Gated on `trust:revoke` rather than `trust:grant`, because narrowing authority must ' +
      'never be blocked by the permission that widens it. THE RUNG ALSO HOLDS, for a stated ' +
      'term: the demotion sets a hold and the ladder may not promote the class back until ' +
      '`manualHoldUntil` — `thresholds.manualHoldDays` from now, the same 14 days a regression ' +
      'is measured over. SHOW THAT DATE. It used to be the other way round: the next hourly ' +
      'evaluation put the class straight back on `promoted` with `changeReason: ' +
      'promoted_on_evidence`, and `rungMayBeRestoredByLadder` existed to warn about it. That ' +
      'field is now false on every successful demotion, but it is still computed from the ' +
      "ladder's own rules rather than hardcoded, so keep rendering the true branch. The hold " +
      'EXPIRES on purpose — a permanent one would be a judgement made in an afternoon that ' +
      'becomes permanent policy because nothing revisits it — and nothing lifts it early. ' +
      'There is no lift endpoint and no promote endpoint, and an operator who changes their ' +
      'mind needs neither: the rung is a measurement, while what makes a class run unattended ' +
      'is a trust grant, which a NON-PROMOTED class can hold and which only a human tap ' +
      'creates. Demoting the class again after the hold lapses places a fresh hold; silence ' +
      'lets it lapse. Re-promotion, whenever it comes, restores eligibility only — the ' +
      'suspended grants stay suspended and nothing resumes running. VISION §7 makes promotion ' +
      'something a class EARNS on evidence and demotion something that happens automatically ' +
      '"not as a judgment call", so the manual direction is available only where it narrows.',
  })
  @ApiParam({ name: 'actionClass', type: String })
  // Optional, matching the schema's default: a demotion must never be harder
  // than it needs to be, since it is the safe direction.
  @ApiBody({ type: DemoteClassDto, required: false })
  @ApiDataResponse(ManualDemotionResultDto, {
    status: 201,
    description: 'The demoted class, and how many grants were suspended',
  })
  @ApiResponse({
    status: 404,
    description: 'No such action class, and no ladder row under that id.',
  })
  @ApiResponse({
    status: 409,
    description:
      'The class is not on the promoted rung, so there is no autonomy to take back and nothing ' +
      'was changed. `details.reason` is `not-promoted` and `details.rung` says where it ' +
      'actually stands. Note that a class can hold trust grants WITHOUT being promoted — ' +
      'grants come from a human tap, not from the ladder — so if something is running ' +
      'unattended, revoke its grant at `DELETE /api/trust/grants/{id}`.',
  })
  async demote(
    @Param('actionClass') actionClass: string,
    @Body() body: DemoteClassDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.promotion.demoteManually(
      actionClass,
      userId,
      body.note ?? null,
    );
  }
}
