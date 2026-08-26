import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import {
  OperatorSettingsDocumentDto,
  type OperatorSettingsDocument,
} from './dto/operator-settings-response.dto';
import {
  PatchOperatorSettingsDto,
  MANAGED_SETTING_KEYS,
} from './dto/patch-operator-settings.dto';
import {
  ProbeRequestDto,
  ProbeResultDto,
  probeNameSchema,
  type ProbeName,
} from './dto/operator-probe.dto';
import { OperatorProbesService } from './probes/operator-probes.service';
import {
  OPERATOR_SETTINGS,
  isOperatorSettingKey,
  type OperatorSettingKey,
} from './operator-settings.registry';
import { OperatorSettingsService } from './operator-settings.service';
import { buildOperatorSettingsDocument } from './operator-settings.view';

/**
 * The Control Center's own API (#338, epic #332).
 *
 * ## Three permissions, not one, and why the third is not the real control
 *
 * Reads need `system_settings:read`. Non-secret writes need
 * `system_settings:write`. A write that touches a SECRET key additionally
 * needs `operator_settings:write_secret`.
 *
 * That third permission is DEFENCE IN DEPTH and nothing more, and saying so
 * plainly matters more than the check itself. What actually keeps an agent
 * away from the GitHub token and the Anthropic key is #334 — the allowlisted
 * subprocess environment, which means an agent never holds a credential it
 * could authenticate this request with — and #346, which refuses
 * non-interactive credentials on this write path so that an Admin-scoped
 * Personal Access Token cannot reach it either. ADR-0018 §6 is explicit that
 * both are preconditions and that "either one missing is sufficient to
 * invalidate this decision, not merely weaken it". A permission string is not
 * a containment barrier; it is a separation of two operator duties that would
 * otherwise be one.
 *
 * ## Why the write path is not one transaction across keys
 *
 * `OperatorSettingsService.set()` and `clear()` each put their row and the
 * collection revision counter in one transaction, which is what makes
 * `If-Match` meaningful. A multi-key `PATCH` runs several of those in
 * sequence, so a failure on the third key leaves the first two applied. That
 * is stated rather than hidden, and it is why the DTO rejects the whole body
 * for an unknown key BEFORE anything is written: the failure that is actually
 * likely — a typo — is caught while nothing has happened yet, and the failure
 * that is not (the database going away mid-patch) leaves the operator with a
 * fresh document showing exactly which keys landed.
 */
@ApiTags('Operator Settings')
@Controller('operator-settings')
export class OperatorSettingsController {
  constructor(
    private readonly settings: OperatorSettingsService,
    private readonly probes: OperatorProbesService,
  ) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'List every operator-managed setting, with provenance',
    description:
      'Returns the whole registry: what each key is, what it currently resolves to, which ' +
      'layer that value came from (`default`, `env` or `database`), when a change takes ' +
      'effect, and whether changing it is dangerous. Also returns the document `revision` for ' +
      '`If-Match` and the overlay `status`, which is `unavailable` when the database could ' +
      'not be read and environment values are what is actually in force.\n\n' +
      '**A secret key never returns its value.** It returns `configured`, `source`, a masked ' +
      '`hint` and `updatedAt`, and nothing else — the response schema has no `value` member ' +
      'on that arm at all.',
  })
  @ApiDataResponse(OperatorSettingsDocumentDto, {
    description: 'The registry, resolved',
  })
  list(): OperatorSettingsDocument {
    return buildOperatorSettingsDocument(this.settings);
  }

  @Patch()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Change some operator settings',
    description:
      'Send **only the keys you are changing**. This is a correctness requirement rather than ' +
      'an optimisation: an absent row means "fall through to the environment", so a body ' +
      "carrying every rendered key would freeze today's defaults into rows and no later " +
      "release's change to a default would ever reach this deployment.\n\n" +
      '`null` for a key deletes its row, reverting it to whatever the environment says — and ' +
      "only to the code's default if the environment says nothing.\n\n" +
      'Writing a key marked `secret` additionally requires `operator_settings:write_secret`.',
  })
  @ApiBody({
    type: PatchOperatorSettingsDto,
    description: `A sparse map of managed keys. Valid keys: ${MANAGED_SETTING_KEYS.join(', ')}`,
    examples: {
      change: {
        summary: 'Change two keys and revert a third',
        value: {
          'dispatch.enabled': true,
          'reconciler.intervalMs': 30000,
          'github.userAgent': null,
        },
      },
    },
  })
  @ApiHeader({
    name: 'If-Match',
    required: false,
    description:
      'The `revision` from a previous `GET`. A stale value answers 409 rather than ' +
      "overwriting somebody else's change. `*` skips the check.",
  })
  @ApiDataResponse(OperatorSettingsDocumentDto, {
    description: 'The registry, re-resolved after the write',
  })
  @ApiResponse({ status: 400, description: 'Unknown key, or a rejected value' })
  @ApiResponse({ status: 409, description: 'Stale If-Match revision' })
  @ApiResponse({
    status: 503,
    description: 'A secret was written with no encryption key configured',
  })
  async patch(
    @Body() body: PatchOperatorSettingsDto,
    @CurrentUser() user: RequestUser | undefined,
    @Headers('if-match') ifMatch?: string,
  ): Promise<OperatorSettingsDocument> {
    const changes = Object.entries(body as Record<string, unknown>).map(
      ([key, value]) => {
        // The DTO already refused an unknown key; this narrows the type
        // without a cast, and would throw rather than write to a key the
        // registry does not know if the two ever disagreed.
        if (!isOperatorSettingKey(key)) {
          throw new BadRequestException(
            `"${key}" is not a managed setting key`,
          );
        }
        return { key, value };
      },
    );

    this.assertMaySetSecrets(changes, user);

    // Before the check, not after: the in-memory revision is refreshed on a
    // 15-second loop, so comparing against it directly would both reject a
    // caller holding a perfectly current ETag and accept one holding an ETag
    // that went stale eleven seconds ago. The point of `If-Match` is to be
    // exact about this.
    await this.settings.refresh();
    this.assertFresh(ifMatch);

    for (const { key, value } of changes) {
      if (value === null) {
        await this.settings.clear(key, user?.id ?? null);
      } else {
        await this.settings.set(key, value, user?.id ?? null);
      }
    }

    return buildOperatorSettingsDocument(this.settings);
  }

  @Post('probes/:probe')
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Test a credential or a binary for real',
    description:
      'Each probe answers `{ ok, detail, checkedAt }`. A failing credential is `ok: false` ' +
      'with a readable `detail`, not an error status — "the probe failed" and "the probe ' +
      'found a failure" are the two things this endpoint exists to tell apart.\n\n' +
      '`claude-credential` and `supervisor-model` make a real, billed call, because that is ' +
      'the only thing that proves a credential works: `claude --version` succeeds without ' +
      'one, so an unauthenticated CLI registers as an available runner and then fails every ' +
      'run at auth. Both are rate limited, and the allowance is reported in `rateLimit` so it ' +
      'can be shown before it runs out.',
  })
  @ApiParam({ name: 'probe', enum: probeNameSchema.options })
  @ApiBody({ type: ProbeRequestDto, required: false })
  @ApiDataResponse(ProbeResultDto, { description: 'What the probe found' })
  @ApiResponse({ status: 400, description: 'Unknown probe name' })
  async probe(
    @Param('probe') probe: string,
    @Body() body?: ProbeRequestDto,
  ): Promise<unknown> {
    const parsed = probeNameSchema.safeParse(probe);

    if (!parsed.success) {
      // A 400 rather than a 404: the collection of probes exists and is
      // closed, so an unrecognised name is a malformed request rather than a
      // missing resource — and the message can then list the real ones.
      throw new BadRequestException(
        `"${probe}" is not a probe. Valid probes: ${probeNameSchema.options.join(', ')}`,
      );
    }

    return this.probes.run(parsed.data as ProbeName, {
      ...(body?.repositoryId ? { repositoryId: body.repositoryId } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Guards this controller applies itself
  // -------------------------------------------------------------------------

  /**
   * A secret write needs the second permission, and the refusal names the keys.
   *
   * Checked here rather than by a guard because it depends on the BODY: the
   * same route is an ordinary settings write for `dispatch.enabled` and a
   * credential rotation for `github.token`, and `@Auth()` is evaluated before
   * any of that is known.
   */
  private assertMaySetSecrets(
    changes: Array<{ key: OperatorSettingKey }>,
    user: RequestUser | undefined,
  ): void {
    const secrets = changes
      .map(({ key }) => key)
      .filter((key) => OPERATOR_SETTINGS[key].secret);

    if (secrets.length === 0) return;

    if (
      user?.permissions.includes(PERMISSIONS.OPERATOR_SETTINGS_WRITE_SECRET) !==
      true
    ) {
      throw new ForbiddenException(
        `Missing permissions: ${PERMISSIONS.OPERATOR_SETTINGS_WRITE_SECRET} ` +
          `(required to write ${secrets.join(', ')})`,
      );
    }
  }

  /**
   * `If-Match`, or the absence of it.
   *
   * Absent means "no check", matching `PATCH /api/system-settings`. `*` is the
   * RFC 7232 wildcard and means the same thing explicitly. A quoted or weak
   * ETag is accepted because that is the form a browser round-trips.
   */
  private assertFresh(ifMatch: string | undefined): void {
    if (ifMatch === undefined || ifMatch.trim() === '') return;

    const raw = ifMatch.trim();
    if (raw === '*') return;

    const unquoted = raw.replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
    const expected = Number(unquoted);

    if (!Number.isInteger(expected)) {
      throw new BadRequestException(
        `If-Match must be the revision number from a previous GET, or "*". ` +
          `Received: ${ifMatch}`,
      );
    }

    const current = this.settings.overlay().revision;

    if (current === null) {
      throw new ConflictException(
        'The settings revision could not be read, so If-Match cannot be ' +
          'checked. The database overlay is unavailable — re-read GET ' +
          '/api/operator-settings and look at `status`.',
      );
    }

    if (current !== expected) {
      throw new ConflictException(
        `These settings changed since you read them (revision ${current}, ` +
          `you sent ${expected}). Re-read them and re-apply your change.`,
      );
    }
  }
}
