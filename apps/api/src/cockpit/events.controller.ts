import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { ActivityEventDto, EventsQueryDto } from './dto/events.dto';
import { EventsService } from './events.service';

/**
 * The activity feed.
 *
 * Gated on `runs:read`, the same string the run timeline enforces — these are
 * the same rows read a different way, and gating them differently would let
 * somebody watch events on runs they cannot open.
 *
 * NOTE the route: `/events`, not `/run-events`. `RunEventsController` already
 * owns `POST /api/run-events`, where runners REPORT. This is the read side and
 * deliberately a different path, so the write surface stays one greppable
 * place (#53).
 */
@ApiTags('Cockpit')
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.RUNS_READ] })
  @ApiOperation({
    summary: 'The normalized event floor across every run, newest first',
    description:
      'Not the same as /runs/{id}/events, which is one run’s timeline: this spans runs, so every ' +
      'row names its run and work order. RunEvent is high-volume (#39) — a single run emits a ' +
      'progress event per tool call plus heartbeats — so the default page is 20, matching what ' +
      'the dashboard panel asks for. `source` says whether a runner reported the event, the git ' +
      'watcher derived it, or the control plane synthesized it: VISION §9 requires that a ' +
      'synthesized event never masquerade as a report, which is why it is a field rather than a ' +
      'note in the summary. Filters take the WIRE spelling (run.started, control-plane), never ' +
      'the database’s.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'type', required: false, type: String })
  @ApiQuery({ name: 'source', required: false, type: String })
  @ApiDataResponse(ActivityEventDto, { pagination: 'flat', description: 'Paginated activity' })
  async feed(@Query() query: EventsQueryDto) {
    return this.events.feed(query);
  }
}
