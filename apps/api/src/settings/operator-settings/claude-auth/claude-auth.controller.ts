import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../../common/constants/roles.constants';
import { ApiDataResponse } from '../../../common/decorators/api-data-response.decorator';
import { ClaudeAuthService } from './claude-auth.service';
import {
  ClaudeAuthSessionDto,
  SubmitClaudeAuthCodeDto,
  type ClaudeAuthSession,
} from './dto/claude-auth.dto';

/**
 * Connect a Claude subscription without a shell (#386, epic #332).
 *
 * ## Gated exactly as a secret write is, and for the same reasons
 *
 * Every route here carries `system_settings:write` +
 * `operator_settings:write_secret` + `interactive: true`, which is what
 * `PATCH /api/operator-settings` applies when its body touches a secret key —
 * because that is precisely what this is. The end of this flow is a write to
 * `runners.claudeCodeLocal.oauthToken`, and routing it through a different
 * door with a lighter lock would make the lock on the first door decorative.
 *
 * The interactive requirement (#346) is the one that does the work. A personal
 * access token cannot start or finish this, no matter what permissions it
 * carries — and it should not be able to, twice over: the flow mints a
 * long-lived subscription credential, and the only thing that can complete it
 * is a human who has just signed in to a Claude account in a browser. A
 * non-interactive caller could not finish it anyway; refusing at the door is
 * what makes the attempt visible in `audit_events` instead of looking like a
 * flow that quietly timed out.
 *
 * There is no read-only route here. `GET /:sessionId` is a poll of an
 * in-flight write and is gated identically — unlike `GET /api/operator-
 * settings`, which is deliberately open to automation because observing
 * configuration changes nothing.
 *
 * ## Every response is the same shape
 *
 * All four routes answer a `ClaudeAuthSessionDto`, so the UI has one renderer
 * and one polling shape rather than four. `configured` is the success signal
 * and the token is never in the body — see the DTO's header.
 */
@ApiTags('Operator Settings')
@Controller('operator-settings/claude-auth')
@Auth({
  permissions: [
    PERMISSIONS.SYSTEM_SETTINGS_WRITE,
    PERMISSIONS.OPERATOR_SETTINGS_WRITE_SECRET,
  ],
  interactive: true,
})
export class ClaudeAuthController {
  constructor(private readonly claudeAuth: ClaudeAuthService) {}

  @Post('start')
  // 201, and documented as 201. A sign-in session is a resource with an
  // identifier that did not exist before this call, and the OpenAPI document
  // is the contract the web client is generated against — a document
  // promising 200 while the route answers 201 is drift the `openapi:lint`
  // gate cannot see, because both are valid documents.
  @ApiOperation({
    summary: 'Begin connecting a Claude subscription',
    description:
      'Starts `claude setup-token` on a pseudo-terminal and returns the OAuth ' +
      '`url` it prints. Open that URL, sign in to the Claude account whose ' +
      'subscription should pay for automated runs, authorise, and post the ' +
      'code it gives you back to `/{sessionId}/code`.\n\n' +
      'Only one sign-in runs at a time — a second `start` while one is live ' +
      'answers 409 and names the session to cancel. The response blocks until ' +
      'the CLI has printed its URL, which normally takes a few seconds.\n\n' +
      '**Requires an interactive session.** A personal access token is ' +
      'refused: this mints a long-lived credential, and finishing it needs a ' +
      'human in a browser regardless.',
  })
  @ApiDataResponse(ClaudeAuthSessionDto, {
    status: HttpStatus.CREATED,
    description: 'A live sign-in, with the URL to open',
  })
  @ApiResponse({
    status: 409,
    description: 'Another sign-in is already in progress',
  })
  start(
    @CurrentUser('id') userId: string | undefined,
  ): Promise<ClaudeAuthSession> {
    return this.claudeAuth.start(userId ?? null);
  }

  @Get(':sessionId')
  @ApiOperation({
    summary: 'Poll a sign-in',
    description:
      'The same shape `start` returned. `status` moves `awaiting_code` → ' +
      '`exchanging` → `completed`, or ends at `failed`, `cancelled` or ' +
      '`expired` with an `error` that names one of four distinct causes.',
  })
  @ApiParam({ name: 'sessionId', format: 'uuid' })
  @ApiDataResponse(ClaudeAuthSessionDto, { description: 'The sign-in' })
  @ApiResponse({ status: 404, description: 'No such sign-in' })
  get(@Param('sessionId') sessionId: string): ClaudeAuthSession {
    return this.claudeAuth.get(sessionId);
  }

  @Post(':sessionId/code')
  // 200, not the POST default of 201: this changes a session that already
  // exists rather than creating one, and the body it returns is the same
  // session `start` and `GET` return.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit the code the browser gave you',
    description:
      "Writes the code to the CLI's standard input and waits for the vendor " +
      'exchange to finish. On success the token is sealed into ' +
      '`runners.claudeCodeLocal.oauthToken` through the same encrypted path a ' +
      'manual entry uses — History records it as `set` and the readiness step ' +
      'flips.\n\n' +
      '**The token is never returned.** Success is `status: "completed"` with ' +
      '`configured: true`, and that is the whole of it.\n\n' +
      'A session accepts exactly one code. A rejected code ends it; start a ' +
      'new sign-in, because the authorization challenge is already spent.',
  })
  @ApiParam({ name: 'sessionId', format: 'uuid' })
  @ApiDataResponse(ClaudeAuthSessionDto, {
    description: 'The finished sign-in',
  })
  @ApiResponse({ status: 400, description: 'Missing or malformed code' })
  @ApiResponse({
    status: 404,
    description: 'No such sign-in',
  })
  @ApiResponse({
    status: 409,
    description: 'This sign-in is not waiting for a code',
  })
  @ApiResponse({
    status: 503,
    description: 'A token was produced with no encryption key configured',
  })
  submitCode(
    @Param('sessionId') sessionId: string,
    @Body() body: SubmitClaudeAuthCodeDto,
    @CurrentUser('id') userId: string | undefined,
  ): Promise<ClaudeAuthSession> {
    return this.claudeAuth.submitCode(sessionId, body.code, userId ?? null);
  }

  @Delete(':sessionId')
  @ApiOperation({
    summary: 'Cancel a sign-in',
    description:
      'Kills the CLI process group and marks the session `cancelled`. Nothing ' +
      'is written. Safe to call on a sign-in that has already ended.',
  })
  @ApiParam({ name: 'sessionId', format: 'uuid' })
  @ApiDataResponse(ClaudeAuthSessionDto, {
    description: 'The cancelled sign-in',
  })
  @ApiResponse({ status: 404, description: 'No such sign-in' })
  cancel(@Param('sessionId') sessionId: string): ClaudeAuthSession {
    return this.claudeAuth.cancel(sessionId);
  }
}
