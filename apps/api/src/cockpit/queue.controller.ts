import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { QueueEntryDto, QueueQueryDto } from './dto/queue.dto';
import { QueueService } from './queue.service';

/**
 * The dispatch queue.
 *
 * Gated on `workorders:read` — the string
 * `apps/web/src/config/destinations.ts` gates the queue destination on. That
 * file's rule is that a destination's permission is the one its controller
 * REALLY enforces, verified rather than assumed, which is why the destination
 * flips from `planned` to `live` in the same pull request as this controller
 * and never before it.
 */
@ApiTags('Cockpit')
@Controller('queue')
export class QueueController {
  constructor(private readonly queue: QueueService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.WORKORDERS_READ] })
  @ApiOperation({
    summary: 'List queued and held work orders, in dispatch order',
    description:
      'Position 1 is the work order the next reconciler tick will pick up — this is the same ' +
      'order the dispatch pass drains in. `state` answers why a work order is not running yet: ' +
      '`held` is a policy outcome that clears when a human acts, `waiting` a scheduling one that ' +
      'clears on its own, and `ready` means a runner could take it right now. Dispatched work ' +
      'orders are NOT listed; they have a run and belong to the runs screen.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiDataResponse(QueueEntryDto, {
    isArray: true,
    description: 'Queued and held work orders, in dispatch order',
  })
  async list(@Query() query: QueueQueryDto) {
    return this.queue.list(query.limit);
  }
}
