import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { CostQueryDto, CostSummaryDto } from './dto/cost.dto';
import { CostService } from './cost.service';

/**
 * Spend.
 *
 * Gated on `runs:read`, which is what it reads: cost lives on the run, and
 * gating an aggregate more loosely than its rows would let somebody total up
 * runs they cannot open.
 */
@ApiTags('Cockpit')
@Controller('cost')
export class CostController {
  constructor(private readonly cost: CostService) {}

  @Get('summary')
  @Auth({ permissions: [PERMISSIONS.RUNS_READ] })
  @ApiOperation({
    summary: 'Spend over a window, with the unmeasured part counted',
    description:
      'Read `totalUsd` and `runsWithoutCost` together. `Run.costUsd` is nullable because a ' +
      'runner may not report cost at all (`reportsCost` in the capability manifest), so a total ' +
      'over a window where most runs reported nothing is a FLOOR, not a figure — and a cost ' +
      'screen that showed only the total would understate spend while looking precise. ' +
      '`totalUsd` is null, never 0, when nothing reported. `quota` is always null: VISION §11’s ' +
      'shared quota is the agent subscription and nothing records consumption against a window ' +
      'capacity, so it is named here as unavailable rather than approximated from the GitHub ' +
      'rate limit, which would answer a different question under this one’s label.',
  })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiDataResponse(CostSummaryDto, {
    description: 'Spend, and how much of it is known',
  })
  async summary(@Query() query: CostQueryDto) {
    return this.cost.summary(query.days);
  }
}
