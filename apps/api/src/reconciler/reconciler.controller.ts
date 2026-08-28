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
      'whenever GitHub writes are off — which since ADR-0019 is a deliberate observation-week ' +
      'posture rather than the shipped default, so on a normal deployment a zero here means ' +
      'there was nothing to do, not that acting was forbidden. It is not a subset of ' +
      "actionsComputed. executionFailures says which of a tick's own acting-phase writes went " +
      'wrong and why — null when no executor ran at all on that tick, [] when one ran and ' +
      'reported nothing, so the two are not interchangeable. settings is the retryCeiling, ' +
      'rateLimitReserve and writesEnabled this tick actually ran under, read once at the top of ' +
      'the tick rather than frozen at process start — null there means the row predates the ' +
      'column, not that defaults applied. Use actionsOnly=true to skip the quiet ticks, which ' +
      'are the great majority.',
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
      'stored only when there was something to review. executionFailures is null for a tick ' +
      'whose acting-phase executors never ran, which is different from [], meaning they ran and ' +
      "nothing failed. It covers the reconciler's own writes — mirror labels and spec-feedback " +
      "comments — and not dispatch's, whose failures are recorded on the run. settings carries " +
      'the retryCeiling, rateLimitReserve and writesEnabled this tick was configured with when ' +
      'it ran, so the mode a tick actually ran under is answerable from this row alone — null ' +
      'there means the tick predates the column, not that defaults applied.',
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
