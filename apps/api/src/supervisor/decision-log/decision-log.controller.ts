import {
  Body,
  Controller,
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

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { getActionClass } from '../action-classes';
import {
  ApprovalRateDto,
  ApprovalRatesQueryDto,
  InvocationDto,
  ProposalDto,
  ProposalsQueryDto,
  ReviewProposalDto,
} from '../dto/decision-log.dto';
import { DecisionLogService } from './decision-log.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The supervisor decision log (#90).
 *
 * ## There is no execute endpoint, and there never will be one here
 *
 * Read the log, and record whether a proposal would have been approved. That
 * is the whole surface. VISION §7 rung 1 is "the supervisor writes proposals
 * to a decision log and executes nothing", and an endpoint that applied a
 * proposal would move the system to rung 3 for every action class at once —
 * bypassing the measurement the ladder is built on.
 *
 * Gated on `supervisor:read` and `supervisor:review`. The two are separate for
 * the reason `escalations:acknowledge` is separate from `escalations:read`: the
 * verdict is not an observation, it is the evidence that grants autonomy
 * later.
 */
@ApiTags('Supervisor')
@Controller('supervisor')
export class DecisionLogController {
  constructor(private readonly log: DecisionLogService) {}

  @Get('proposals')
  @Auth({ permissions: [PERMISSIONS.SUPERVISOR_READ] })
  @ApiOperation({
    summary: 'The decision log, newest first',
    description:
      'Includes proposals the supervisor DECLINED to make. Those are rows, not absences: an ' +
      'action class that is never proposed looks identical to one that is always proposed ' +
      'correctly, and the promotion ladder has to be able to tell them apart. Filter by ' +
      '`outcome=proposed` to see only what a human could have approved. `snapshotTruncated` ' +
      'says whether the snapshot behind the proposal showed the whole factory — a proposal ' +
      'made from a partial view may be wrong for a reason that is not the supervisor’s fault.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'actionClass', required: false, type: String })
  @ApiQuery({ name: 'review', required: false, type: String })
  @ApiQuery({ name: 'outcome', required: false, type: String })
  @ApiDataResponse(ProposalDto, {
    pagination: 'flat',
    description: 'Paginated proposals',
  })
  async proposals(@Query() query: ProposalsQueryDto) {
    return this.log.listProposals(query);
  }

  @Get('invocations/:id')
  @Auth({ permissions: [PERMISSIONS.SUPERVISOR_READ] })
  @ApiOperation({
    summary: 'One invocation, including the exact snapshot the model saw',
    description:
      'The snapshot text lives here rather than on each proposal because one invocation renders ' +
      'one snapshot and may produce several proposals from it. It is stored rather than ' +
      're-derived: re-rendering would render TODAY’s factory, and a proposal reviewed a week ' +
      'later would be judged against a state that has moved.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(InvocationDto, { description: 'The invocation' })
  @ApiResponse({ status: 404, description: 'Invocation not found' })
  async invocation(@Param('id', ParseUUIDPipe) id: string) {
    return this.log.getInvocation(id);
  }

  @Post('proposals/:id/review')
  @Auth({ permissions: [PERMISSIONS.SUPERVISOR_REVIEW] })
  @ApiOperation({
    summary: 'Record whether this proposal would have been approved',
    description:
      'VISION §7 rung 2, and the entire Phase 6 measurement. Recording a verdict does NOT ' +
      'execute the proposal — nothing in this API does. A verdict can be changed, but the ' +
      'proposal itself is never rewritten: editing the summary or the reasoning would make the ' +
      'approval rate a measurement of hindsight. `pending` is not an accepted verdict, because ' +
      'un-reviewing silently removes evidence the ladder has already counted.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Verdict recorded' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  async review(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewProposalDto,
    @CurrentUser('id') userId: string,
  ) {
    await this.log.review(id, body.verdict, userId ?? null, body.note);
    return { id, review: body.verdict };
  }

  @Get('approval-rates')
  @Auth({ permissions: [PERMISSIONS.SUPERVISOR_READ] })
  @ApiOperation({
    summary:
      'Per action class, the fraction of proposals a human would have approved',
    description:
      'The input to promotion (VISION §7 rung 2). Every registered class appears, including ' +
      'ones nothing has proposed — absence and zero evidence are different facts. ' +
      '`approvalRate` is null when nothing has been reviewed, never 0: a class with no reviewed ' +
      'proposals has no evidence, and 0% would say the opposite. `hasProposer` says whether ' +
      'anything in this phase even produces the class, and `autonomyEligible` whether it may ' +
      'ever be promoted at all (ADR-0011 marks quarantine decisions ineligible).',
  })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiDataResponse(ApprovalRateDto, {
    isArray: true,
    description: 'Approval rate per action class',
  })
  async approvalRates(@Query() query: ApprovalRatesQueryDto) {
    const since = query.days
      ? new Date(Date.now() - query.days * DAY_MS)
      : undefined;
    const rates = await this.log.approvalRates(since);

    // The registry facts are joined here rather than stored on each row: they
    // describe the CLASS, not the measurement, and a copy in the database
    // would be the drift ADR-0011 put the taxonomy in one file to prevent.
    return rates.map((rate) => {
      const entry = getActionClass(rate.actionClass);
      return {
        ...rate,
        hasProposer: entry?.hasProposer ?? false,
        autonomyEligible: entry?.autonomyEligible ?? false,
      };
    });
  }
}
