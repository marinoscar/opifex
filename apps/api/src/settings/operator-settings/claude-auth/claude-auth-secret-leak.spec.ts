import { Logger } from '@nestjs/common';

import {
  FakeOperatorSettingsPrisma,
  TEST_ENCRYPTION_KEY,
  makeOperatorSettings,
} from '../../../../test/fixtures/operator-settings.fixture';
import {
  FAKE_OAUTH_TOKEN,
  makeFakeClaudeCli,
  type FakeClaudeCli,
} from '../../../../test/fixtures/fake-claude-cli';
import { ENCRYPTION_KEY_ENV_VAR } from '../../../common/crypto/secret-box';
import { REVEALED_SUFFIX_LENGTH } from '../../../common/crypto/redact';
import { OperatorSettingsController } from '../operator-settings.controller';
import { SupervisorModelCatalogService } from '../../../supervisor/invocation/model-catalog.service';
import type { OperatorProbesService } from '../probes/operator-probes.service';
import type { OperatorSettingsService } from '../operator-settings.service';
import { ClaudeAuthController } from './claude-auth.controller';
import { ClaudeAuthService } from './claude-auth.service';
import { claudeAuthSessionSchema } from './dto/claude-auth.dto';

/**
 * THE test for #386's central promise: the token never reaches the browser.
 *
 * The flow mints a live, year-long subscription credential inside the API
 * process. Every other secret in this system arrives from outside it and is
 * only ever masked on the way back out; this one is BORN here, which means a
 * single careless `return { ...session }` would ship it to the browser on the
 * happy path — the path everybody tests by clicking, and nobody tests by
 * reading the JSON.
 *
 * ## Why it greps the whole serialized response
 *
 * The same argument `operator-settings-secret-leak.spec.ts` makes, and it is
 * worth repeating rather than cross-referencing: a field-by-field assertion
 * tests the fields somebody thought of. The failure this endpoint has to be
 * incapable of is the token arriving through a field nobody thought of — a
 * debugging aid left in, a spread that carried more than intended, an `error`
 * message that quoted CLI output verbatim. Only a search of the entire body
 * catches those, and only that search keeps catching them as the shape
 * changes.
 *
 * It runs against EVERY endpoint, not just the one that produces the token,
 * because the session object outlives the exchange: a poll or a cancel after
 * completion reads the same in-memory record.
 */

/** Every contiguous run of `value` longer than `length`. */
function runsLongerThan(value: string, length: number): string[] {
  const runs: string[] = [];
  const size = length + 1;
  for (let start = 0; start + size <= value.length; start += 1) {
    runs.push(value.slice(start, start + size));
  }
  return runs;
}

/** Asserts the token is absent, and that no long piece of it is present. */
function expectNoToken(serialized: string): void {
  expect(serialized).not.toContain(FAKE_OAUTH_TOKEN);
  // The stronger claim. Asserting only the whole string would pass a response
  // that leaked all but the final character; the settings document is allowed
  // to reveal four characters as a mask hint, so nothing anywhere may reveal
  // five in a row.
  for (const run of runsLongerThan(FAKE_OAUTH_TOKEN, REVEALED_SUFFIX_LENGTH)) {
    expect(serialized).not.toContain(run);
  }
}

class FastClaudeAuthService extends ClaudeAuthService {
  protected override readonly pollIntervalMs: number = 20;
  protected override readonly startupTimeoutMs: number = 15_000;
  protected override readonly exchangeTimeoutMs: number = 15_000;
}

describe('The Claude sign-in flow never returns the token (#386)', () => {
  let settings: OperatorSettingsService;
  let prisma: FakeOperatorSettingsPrisma;
  let service: FastClaudeAuthService;
  let controller: ClaudeAuthController;
  let cli: FakeClaudeCli;

  jest.setTimeout(60_000);

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    process.env[ENCRYPTION_KEY_ENV_VAR] = TEST_ENCRYPTION_KEY;

    ({ settings, prisma } = await makeOperatorSettings({ env: {} }));
    cli = await makeFakeClaudeCli('success');
    await settings.set('runners.claudeCodeLocal.binary', cli.binary, null);

    service = new FastClaudeAuthService(settings);
    controller = new ClaudeAuthController(service);
  });

  afterEach(async () => {
    service.onModuleDestroy();
    await cli.cleanup();
    jest.restoreAllMocks();
    delete process.env[ENCRYPTION_KEY_ENV_VAR];
  });

  it('is not in any of the four responses, at any point in the flow', async () => {
    const bodies: unknown[] = [];

    const started = await controller.start('operator-1');
    bodies.push(started);
    bodies.push(controller.get(started.sessionId));

    const completed = await controller.submitCode(
      started.sessionId,
      { code: 'the-pasted-code' },
      'operator-1',
    );
    bodies.push(completed);

    // After completion, deliberately: the record is still in memory and a
    // poll or a cancel reads the same object the exchange just wrote to.
    bodies.push(controller.get(started.sessionId));
    bodies.push(controller.cancel(started.sessionId));

    // The flow really did work — otherwise this whole file would be asserting
    // the absence of a token that was never produced, which is the most
    // comfortable way for a leak test to be worthless.
    expect(completed.status).toBe('completed');
    expect(completed.configured).toBe(true);
    expect(settings.get('runners.claudeCodeLocal.oauthToken')).toBe(
      FAKE_OAUTH_TOKEN,
    );

    expectNoToken(JSON.stringify(bodies));
  });

  it('is not in the settings document the UI reads next either', async () => {
    // The end of the operator's journey: the Configuration screen re-reads
    // the whole registry the moment the sign-in completes. A token that stays
    // out of the sign-in responses and then appears here is the same leak,
    // one screen later.
    const started = await controller.start('operator-1');
    await controller.submitCode(started.sessionId, { code: 'x' }, 'operator-1');

    const settingsController = new OperatorSettingsController(
      settings,
      {} as unknown as OperatorProbesService,
      {} as unknown as SupervisorModelCatalogService,
    );

    expectNoToken(JSON.stringify(settingsController.list()));
  });

  it('is stored as ciphertext, never as a plaintext row', async () => {
    const started = await controller.start('operator-1');
    await controller.submitCode(started.sessionId, { code: 'x' }, 'operator-1');

    const row = prisma.rows.get('runners.claudeCodeLocal.oauthToken');

    expect(row?.value).toBeNull();
    expect(row?.secretCiphertext).toEqual(expect.any(String));
    expectNoToken(JSON.stringify([...prisma.rows.values()]));
  });

  it('is not written into the audit row the seal files', async () => {
    // #337's rule, applied here: a plaintext secret in `audit_events.meta` is
    // permanent — nothing added later removes it from the history.
    const started = await controller.start('operator-1');
    await controller.submitCode(started.sessionId, { code: 'x' }, 'operator-1');

    expect(prisma.audits.length).toBeGreaterThan(0);
    expectNoToken(JSON.stringify(prisma.audits));
  });

  it('is stripped by the response schema even if a handler smuggles it', () => {
    // The "field nobody thought about", simulated. It asserts the STRIP
    // rather than the handler: the handler is code somebody will edit, and
    // the schema is what makes the guarantee survive the edit.
    const smuggled = {
      sessionId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      status: 'completed',
      url: null,
      startedAt: '2026-08-26T10:00:00.000Z',
      expiresAt: '2026-08-26T10:10:00.000Z',
      configured: true,
      error: null,
      debugToken: FAKE_OAUTH_TOKEN,
    };

    const stripped = JSON.stringify(claudeAuthSessionSchema.parse(smuggled));

    expect(JSON.stringify(smuggled)).toContain(FAKE_OAUTH_TOKEN);
    expectNoToken(stripped);
  });

  it('says only `configured: true`, and nothing about what was configured', () => {
    // The positive half of the promise. `configured` is the entire success
    // signal, so the schema must have no member that could ever hold a value.
    const members = Object.keys(claudeAuthSessionSchema.shape);

    expect(members).toEqual([
      'sessionId',
      'status',
      'url',
      'startedAt',
      'expiresAt',
      'configured',
      'error',
    ]);
    expect(members).not.toContain('token');
  });
});
