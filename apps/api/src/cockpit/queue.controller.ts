import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { QueueEntryDto, QueueQueryDto } from './dto/queue.dto';
import { QueueService } from './queue.service';
import { QueueSteeringService } from './queue-steering.service';

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
  constructor(
    private readonly queue: QueueService,
    private readonly steering: QueueSteeringService,
  ) {}

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

  /**
   * Ask the factory to stop acting on this work order's issue.
   *
   * Writes `factory:hold` and nothing else. VISION §3.3 makes labels "a
   * bidirectional edge, never the state machine", so this endpoint is a UI over
   * the input label — the effect arrives on the next reconciler tick, exactly
   * as it would if the operator had typed the label into GitHub themselves.
   *
   * 202, not 200: the request has been accepted and is not yet in force. A 200
   * would imply the queue had already changed, which is the optimistic lie #116
   * asks the response to avoid.
   */
  @Post(':workOrderId/hold')
  @Auth({ permissions: [PERMISSIONS.WORKORDERS_WRITE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Apply factory:hold to a work order's issue",
    description:
      'Writes the input label and returns. The reconciler acts on it next tick, so the ' +
      'response reports `labelWritten` and `reconciled` separately — the second is always ' +
      'false here, and a UI that showed the work order as held before a tick had run would ' +
      'be showing a state the control plane has not reached.',
  })
  @ApiParam({
    name: 'workOrderId',
    description: 'Row id or work-order identity',
  })
  @ApiResponse({
    status: 202,
    description: 'Label written; effective next tick',
  })
  @ApiResponse({ status: 404, description: 'Work order not found' })
  async hold(
    @Param('workOrderId') workOrderId: string,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.steering.hold(workOrderId, actorUserId);
  }

  /**
   * Authorize this work order's issue for dispatch again.
   *
   * Writes `factory:ready`. There is deliberately NO endpoint for
   * `factory:clear-quarantine`: #49 requires a human apply it on GitHub, where
   * the applier's identity is native and verifiable from the issue timeline.
   * Proxying it here would launder the actor — every clear would look like it
   * came from the Opifex token, and VISION §8's rule that an agent cannot clear
   * its own quarantine would stop being enforceable.
   */
  @Post(':workOrderId/release')
  @Auth({ permissions: [PERMISSIONS.WORKORDERS_WRITE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Apply factory:ready to a work order's issue",
    description:
      'The counterpart to hold. Does NOT clear quarantine — that label must be applied by a ' +
      'human on GitHub so the actor is verifiable (#49, VISION §8).',
  })
  @ApiParam({
    name: 'workOrderId',
    description: 'Row id or work-order identity',
  })
  @ApiResponse({
    status: 202,
    description: 'Label written; effective next tick',
  })
  @ApiResponse({ status: 404, description: 'Work order not found' })
  async release(
    @Param('workOrderId') workOrderId: string,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.steering.release(workOrderId, actorUserId);
  }
}
