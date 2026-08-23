import { Controller, Get, Param, Query } from '@nestjs/common';
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
  WorkOrderDetailDto,
  WorkOrderListItemDto,
  WorkOrdersQueryDto,
} from './dto/work-orders.dto';
import { WorkOrdersService } from './work-orders.service';

/**
 * Work orders.
 *
 * Gated on `workorders:read` — the same string the queue enforces, because
 * the queue is a view of these rows and gating them differently would let
 * somebody read a work order through one endpoint and not the other.
 */
@ApiTags('Cockpit')
@Controller('work-orders')
export class WorkOrdersController {
  constructor(private readonly workOrders: WorkOrdersService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.WORKORDERS_READ] })
  @ApiOperation({
    summary: 'List work orders, newest first',
    description:
      'Everything the factory has been asked to do, whatever state it reached. Unlike /queue — ' +
      'which lists only what is waiting, in dispatch order — this includes dispatched, ' +
      'succeeded, failed, quarantined, superseded and cancelled work orders, because the ' +
      'question here is history rather than what happens next.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({
    name: 'repository',
    required: false,
    type: String,
    description: 'owner/name',
  })
  @ApiDataResponse(WorkOrderListItemDto, {
    pagination: 'flat',
    description: 'Paginated work orders',
  })
  async list(@Query() query: WorkOrdersQueryDto) {
    return this.workOrders.list(query);
  }

  @Get(':idOrIdentity')
  @Auth({ permissions: [PERMISSIONS.WORKORDERS_READ] })
  @ApiOperation({
    summary: 'Get one work order and the document it authorized',
    description:
      'Accepts either the row id or the identity (wo_opifex_312_a3f91c2_a1) — the identity is ' +
      'the string an operator actually has, since it is what the authorization record shows and ' +
      'what the branch name encodes. `document` is rebuilt from the row by the SAME serializer ' +
      'that produced the bytes committed to the factory branch and posted to the issue (#63), ' +
      'so comparing them is a real check rather than an illustration. A row whose stored ' +
      'identity its own coordinates do not derive returns 422 rather than a lookalike document ' +
      'nothing ever authorized. `baseCommit` is returned in full here, not shortened: it is ' +
      'meant to be checked out.',
  })
  @ApiParam({ name: 'idOrIdentity', type: String })
  @ApiDataResponse(WorkOrderDetailDto, {
    description: 'The work order and its document',
  })
  @ApiResponse({ status: 404, description: 'Work order not found' })
  @ApiResponse({
    status: 422,
    description: 'The stored row disagrees with itself',
  })
  async findOne(@Param('idOrIdentity') idOrIdentity: string) {
    return this.workOrders.findOne(idOrIdentity);
  }
}
