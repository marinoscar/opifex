import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { MetricsQueryDto, MetricsSummaryDto } from './dto/metrics.dto';
import { MetricsService } from './metrics.service';

/**
 * The six success metrics.
 *
 * Gated on `runs:read` — the same string the runs family enforces, because
 * these are aggregates over exactly that data and gating them differently
 * would let somebody read a summary of runs they cannot read.
 *
 * ONE request for the whole stat row rather than six: six requests to paint
 * one row is six chances to render a half-updated screen.
 */
@ApiTags('Cockpit')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('summary')
  @Auth({ permissions: [PERMISSIONS.RUNS_READ] })
  @ApiOperation({
    summary: 'The six VISION §10 success metrics over a window',
    description:
      'A value of null means NOT MEASURED — never zero. Four of the six are null today and the ' +
      'reason for each is documented at MetricsService: dead time needs run state durations ' +
      'nothing records, first-pass acceptance and cost per merged PR need merge state nothing ' +
      'tracks, and quota burn needs consumption against a window capacity nothing captures. ' +
      'Computing something adjacent and labelling it the metric would answer a question nobody ' +
      'asked. `trend` carries only the days that had data, oldest first, because the series ' +
      'cannot express a gap and a zero would draw a line claiming a perfect day.',
  })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiDataResponse(MetricsSummaryDto, { description: 'The stat row, in one request' })
  async summary(@Query() query: MetricsQueryDto) {
    return this.metrics.summary(query.days);
  }
}
