import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import {
  ApplySteeringDto,
  ProposeSteeringDto,
  SteeringApplyResultDto,
  SteeringProposalDto,
} from './dto/steering.dto';
import { SteeringService } from './steering.service';

/**
 * Steering: an instruction becomes a proposed label diff, and then labels.
 *
 * ## Two calls, and why it cannot be one
 *
 * VISION §3.6 — no model output takes effect without passing through
 * deterministic policy. Here the policy is a human reading a concrete list of
 * label operations and confirming it. A single endpoint that translated and
 * applied would collapse that into one round trip and there would be nothing
 * left for the human to confirm: the destructive half of an "only" clause
 * touches issues the operator never named, and the whole point of the proposal
 * is that they see those issues first.
 *
 * ## RBAC
 *
 * `workorders:write` on both, the same permission `POST /api/queue/:id/hold`
 * enforces — and for the reason `queue.controller.ts` states: steering writes
 * `factory:hold` and `factory:ready` to issues, which is precisely what hold
 * and release write. A steering call is a bulk hold/release with a sentence in
 * front of it, and inventing a `steering:*` permission would let a deployment
 * grant one and not the other while both write the same labels to the same
 * issues.
 *
 * PROPOSE carries it too, even though it writes nothing. It reads the whole
 * backlog of a repository to compute a blast radius, and a caller who may not
 * steer has no use for a diff they cannot apply.
 *
 * ## `interactive: true` on apply, and not on propose
 *
 * #346's guard refuses any credential that cannot prove a human was present —
 * no personal access token, no device-flow token. Apply is the one call in
 * this API where a sentence typed by a person becomes an unbounded number of
 * label writes, including removals of intent somebody set deliberately. The
 * confirmation is the safeguard, and a confirmation a script can send is not
 * one. Propose is left open to every credential for the reason that guard's
 * own header gives: reads stay open, because automation observing the factory
 * is a thing to encourage and none of it changes a label.
 */
@ApiTags('Cockpit')
@Controller('steering')
export class SteeringController {
  constructor(private readonly steering: SteeringService) {}

  @Post('proposals')
  @Auth({ permissions: [PERMISSIONS.WORKORDERS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Turn a steering instruction into a proposed diff of label operations',
    description:
      'Writes NOTHING. Returns the label operations that would express the instruction, the ' +
      'blast radius as data (`this will un-ready 17 issues`), and every reference it could not ' +
      'resolve with a reason rather than an error. Removals are carried separately from ' +
      'additions because they are the destructive half — an "only" clause takes `factory:ready` ' +
      'off issues the operator did not name. ' +
      'An instruction naming explicit issue numbers is parsed in code and invokes no model at ' +
      'all; when the parser cannot read the instruction the response says so under ' +
      '`interpretation`, including whether a model could have answered and why none was asked. ' +
      'Scope the instruction with AT MOST ONE of `repository`, `project` (a project id, or ' +
      '`none` for the repositories in no project) and `allRepositories: true`; sending two is a ' +
      '400, because they are three answers to one question rather than three filters. An ' +
      'exclusive instruction — "only work on these, hold everything else" — needs one of them ' +
      'when more than one repository is registered, or its destructive half is reported as ' +
      '`ambiguous-scope` and nothing is swept. A scope is expanded here and stored nowhere. ' +
      'Apply the result with POST /api/steering/proposals/apply, which carries the proposal ' +
      'back: nothing about it is stored, because scope lives in GitHub labels and nowhere else.',
  })
  @ApiDataResponse(SteeringProposalDto, {
    description: 'The proposed diff. Nothing has been written.',
  })
  @ApiResponse({
    status: 404,
    description:
      'The `repository` is not registered with Opifex, or the `project` does not exist. ' +
      'A request parameter naming something Opifex does not know about is a caller mistake; ' +
      'a reference INSIDE the instruction that cannot be resolved is reported under ' +
      '`unresolved` with a reason instead.',
  })
  async propose(@Body() dto: ProposeSteeringDto) {
    return this.steering.propose(dto);
  }

  @Post('proposals/apply')
  @Auth({ permissions: [PERMISSIONS.WORKORDERS_WRITE], interactive: true })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Apply a confirmed steering proposal to GitHub labels',
    description:
      'Re-reads every issue first and reports drift: an issue whose `factory:` labels changed ' +
      'since the proposal was made is SKIPPED and reported, never applied, because the operator ' +
      'confirmed a diff against a picture that has since moved. One drifted issue skips its own ' +
      'operation and not the batch. ' +
      'With `github.writesEnabled` off the operations are recorded and not performed: ' +
      '`writesEnabled` and `labelWritten` say which happened, and `reconciled` is always false ' +
      'because the labels take effect on the next reconciler tick. ' +
      'Only `factory:ready` and `factory:hold` may be written — `factory:clear-quarantine` is ' +
      'rejected by validation, because #49 requires a human apply it on GitHub where the ' +
      "applier's identity is verifiable.",
  })
  @ApiDataResponse(SteeringApplyResultDto, {
    status: 202,
    description: 'Labels written or recorded; effective next tick',
  })
  @ApiResponse({
    status: 409,
    description: 'The proposal has expired; ask for a new one',
  })
  async apply(
    @Body() dto: ApplySteeringDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.steering.apply(dto, actorUserId);
  }
}
