import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
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
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { TickHistoryQueryDto, TickRecordDto } from './dto/tick-history.dto';
import { ReconcileLogService } from './log/reconcile-log.service';

/**
 * The reconciliation log.
 *
 * Gated on `runs:read` — execution observability, which is what a tick record
 * is. The string is the one `apps/web/src/config/destinations.ts` must gate
 * on: that file's rule is that a destination's permission is the string its
 * controller actually enforces, verified rather than assumed.
 */
@ApiTags('Reconciler')
@Controller('reconciler')
export class ReconcilerController {
  constructor(private readonly log: ReconcileLogService) {}

  @Get('ticks')
  @Auth({ permissions: [PERMISSIONS.RUNS_READ] })
  @ApiOperation({
    summary: 'List reconciler ticks, newest first',
    description:
      'The reconciliation log. actionsExecuted counts the GitHub writes a tick issued — mirror ' +
      'labels, spec-feedback comments, authorization records, dispatch branches — including ' +
      'writes that changed nothing and writes that failed, since both reached GitHub. It is 0 ' +
      'whenever GITHUB_WRITES_ENABLED is off, which is the whole of the VISION §12 observation ' +
      'week: there this log is the record of what the reconciler WOULD have done, and a non-zero ' +
      'value means something is enabled that should not be. It is not a subset of ' +
      'actionsComputed. Use actionsOnly=true to skip the quiet ticks, which are the great ' +
      'majority.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'outcome', required: false, type: String })
  @ApiQuery({ name: 'actionsOnly', required: false, type: Boolean })
  @ApiDataResponse(TickRecordDto, {
    pagination: 'flat',
    description: 'Paginated tick history',
  })
  async listTicks(@Query() query: TickHistoryQueryDto) {
    return this.log.history(query);
  }

  @Get('ticks/:id')
  @Auth({ permissions: [PERMISSIONS.RUNS_READ] })
  @ApiOperation({
    summary: 'Get one tick, with its full projection and action list',
    description:
      'projections and actions are null for a tick that computed nothing — the heavy payload is ' +
      'stored only when there was something to review.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(TickRecordDto, { description: 'The tick' })
  @ApiResponse({ status: 404, description: 'Tick not found' })
  async getTick(@Param('id', ParseUUIDPipe) id: string) {
    const tick = await this.log.findById(id);
    if (!tick) {
      throw new NotFoundException(`Reconcile tick ${id} not found`);
    }
    return tick;
  }
}
