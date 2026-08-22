import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { EscalationResponseDto, ListEscalationsQueryDto } from './dto/escalation.dto';
import { EscalationsService } from './escalations.service';

/**
 * What needs a human.
 *
 * VISION §9: escalation is an action, not telemetry — so it has its own
 * records, its own lifecycle and its own endpoints, rather than being a log
 * line somebody might grep for.
 */
@ApiTags('Escalations')
@Controller('escalations')
export class EscalationsController {
  constructor(private readonly escalations: EscalationsService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.ESCALATIONS_READ] })
  @ApiOperation({
    summary: 'List escalations, newest first',
    description:
      'Use unresolvedOnly=true for the triage view. A delivered-but-unacknowledged escalation ' +
      'still counts as unresolved: the operator was told and has not acted.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'unresolvedOnly', required: false, type: Boolean })
  @ApiDataResponse(EscalationResponseDto, {
    pagination: 'flat',
    description: 'Paginated escalations',
  })
  async list(@Query() query: ListEscalationsQueryDto) {
    return this.escalations.list(query);
  }

  @Post(':id/acknowledge')
  @Auth({ permissions: [PERMISSIONS.ESCALATIONS_ACKNOWLEDGE] })
  @ApiOperation({
    summary: 'Acknowledge an escalation',
    description:
      'Records that a human has seen it — the one fact the lifecycle exists to capture. ' +
      'Acknowledging twice is not an error; the first acknowledgement stands.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(EscalationResponseDto, { description: 'The acknowledged escalation' })
  @ApiResponse({ status: 404, description: 'Escalation not found' })
  async acknowledge(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.escalations.acknowledge(id, userId);
  }
}
