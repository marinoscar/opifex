import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RunEventsService } from './run-events.service';

/**
 * Where runners report what they are doing.
 *
 * Authenticated like everything else — a runner holds a Personal Access Token
 * minted by the operator, which this API already accepts on every
 * authenticated route. #53 asks for the existing PAT or device-flow mechanism
 * rather than a third one, and a third credential type would be a third thing
 * to rotate, revoke and get wrong.
 *
 * Gated on `runs:write`, which is deliberately separate from `runs:cancel`:
 * reporting what happened and deciding to stop a run are different
 * authorities, and a leaked runner credential should not be able to kill the
 * rest of the queue.
 */
@ApiTags('Run Events')
@Controller('runs/:runId/events')
export class RunEventsController {
  constructor(private readonly runEvents: RunEventsService) {}

  @Post()
  @Auth({ permissions: [PERMISSIONS.RUNS_WRITE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Report run events',
    description:
      'Accepts one event or an array of them, validated against schemas/run-event.schema.json. ' +
      'Idempotent on the sender-chosen eventId: a retried delivery is counted as a duplicate, ' +
      'not stored twice and not an error. Only source=runner-reported is accepted here — the ' +
      'other two sources are produced by Opifex, not submitted to it.',
  })
  @ApiParam({ name: 'runId', type: String, format: 'uuid' })
  @ApiBody({
    description: 'A run event, or an array of them. See schemas/run-event.schema.json.',
    schema: {
      oneOf: [
        { type: 'object', additionalProperties: true },
        { type: 'array', items: { type: 'object', additionalProperties: true } },
      ],
    },
  })
  @ApiResponse({
    status: 202,
    description: 'Accepted. Body reports how many were stored and how many were already known.',
  })
  @ApiResponse({
    status: 400,
    description: 'One or more events failed validation; the body names each failure by path.',
  })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async report(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() body: unknown,
  ) {
    // Accepts a single event or a batch. A runner streaming events one at a
    // time and one batching them at the end are both normal, and forcing
    // either into the other's shape is friction for no gain.
    const candidates = Array.isArray(body) ? body : [body];

    return this.runEvents.ingest(runId, candidates);
  }
}
