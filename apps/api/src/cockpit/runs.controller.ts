import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
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
import {
  RunDetailDto,
  RunEventDto,
  RunEventsQueryDto,
  RunSummaryDto,
  RunsQueryDto,
} from './dto/runs.dto';
import { RunsService } from './runs.service';

/**
 * Runs, and their event timelines.
 *
 * Gated on `runs:read` — execution observability. The string is the one
 * `apps/web/src/config/destinations.ts` gates the runs destination on, and
 * that file's rule is that a destination's permission is the one its
 * controller REALLY enforces, verified rather than assumed.
 */
@ApiTags('Cockpit')
@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.RUNS_READ] })
  @ApiOperation({
    summary: 'List runs, newest first, or only those needing a human',
    description:
      'needsAttention=true is a SERVER-side filter and deliberately so: whether a run needs a ' +
      'human is the control plane’s verdict, and a UI filtering by status locally would be ' +
      'the watchdog re-implemented in a browser. It means "has an escalation nobody has ' +
      'acknowledged or resolved" rather than a status list, because that is the thing that ' +
      'drains — a run that failed last week is still failed, and a panel keyed on status fills ' +
      'with history. Attention results are ordered by longest silence first.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'needsAttention', required: false, type: Boolean })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiDataResponse(RunSummaryDto, {
    pagination: 'flat',
    description: 'Paginated runs',
  })
  async list(@Query() query: RunsQueryDto) {
    return this.runs.list(query);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.RUNS_READ] })
  @ApiOperation({
    summary: 'Get one run, with the watchdog checks covering it',
    description:
      'attentionReason and resumesAt are separate fields and must stay that way: the first means ' +
      'a human has to do something, the second means the system will handle it and acting is ' +
      'wasted effort (VISION §9). The event timeline is a separate, paginated endpoint.\n\n' +
      'checkCoverage says which watchdog checks are actually protecting this run, derived from ' +
      'what its runner DECLARED it can do (#104). A status of `unavailable` means the check ' +
      'could not run at all — the failure mode it guards is unguarded here — and is NOT the ' +
      'same as a check that ran and found nothing. Rendering the two alike manufactures false ' +
      'confidence, which VISION §6 calls worse than not having the check. `degraded` means it ' +
      'runs on a weaker signal or a coarser threshold: silence detection on a non-streaming ' +
      'runner watches git commits at 90 minutes, not heartbeats at 90 seconds. It is only on ' +
      'the detail response, not on the list.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(RunDetailDto, { description: 'The run' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return this.runs.findById(id);
  }

  @Get(':id/events')
  @Auth({ permissions: [PERMISSIONS.RUNS_READ] })
  @ApiOperation({
    summary: "One run's normalized event timeline, newest first",
    description:
      'Paginated, and its own endpoint rather than an array on the run: RunEvent is high-volume ' +
      '(#39) — a single run emits a progress event per tool call plus heartbeats — so an ' +
      'unpaginated timeline would not survive a real run. `source` says whether a runner ' +
      'reported the event, the git watcher derived it, or the control plane synthesized it; ' +
      'VISION §9 requires that a synthesized event never masquerade as a report.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiDataResponse(RunEventDto, {
    pagination: 'flat',
    description: 'Paginated event timeline',
  })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async events(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: RunEventsQueryDto,
  ) {
    return this.runs.events(id, query);
  }
}
