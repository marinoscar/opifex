import { Logger } from '@nestjs/common';

import {
  FakeOperatorSettingsPrisma,
  TEST_ENCRYPTION_KEY,
  makeOperatorSettings,
} from '../../../test/fixtures/operator-settings.fixture';
import { ENCRYPTION_KEY_ENV_VAR } from '../../common/crypto/secret-box';
import {
  UnreadableSecretsBootCheck,
  unreadableSecrets,
} from './unreadable-secrets.boot';

/**
 * "A key that cannot be decrypted under its slot fails loudly at BOOT, not at
 * the first model call" — #422's acceptance criterion, tested where it can
 * fail.
 *
 * The claim has two halves and both are easy to lose. That the broken slot is
 * NAMED, with a remedy, at startup; and that a working deployment says nothing
 * at all, because a boot that prints a line per credential slot is a boot
 * whose one real message gets skimmed with the rest.
 */

const STORED = 'ghp_Kx7Vd2Nq9Zb4Mw5Rt8Lp3Jc6Hy1Sn';

describe('the unreadable-secret boot check (#422)', () => {
  let errors: string[];

  beforeEach(() => {
    errors = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    process.env[ENCRYPTION_KEY_ENV_VAR] = TEST_ENCRYPTION_KEY;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env[ENCRYPTION_KEY_ENV_VAR];
  });

  it('names a model credential that will not open, and says what to do', async () => {
    const prisma = new FakeOperatorSettingsPrisma();
    prisma.sealInto('models.anthropic.apiKey', 'sk-ant-api03-Mq8Vz3Nb6Kd2');
    prisma.corrupt('models.anthropic.apiKey');

    const { settings } = await makeOperatorSettings({ prisma });
    new UnreadableSecretsBootCheck(settings).onModuleInit();

    const said = errors.join('\n');
    expect(said).toContain('models.anthropic.apiKey');
    expect(said).toContain('decrypt_failed');
    expect(said).toContain('OPIFEX_SETTINGS_ENCRYPTION_KEY');
  });

  it('does not report the environment as a working fallback', async () => {
    // The rule `secret-box.ts` exists to enforce, restated where an operator
    // reads it: a stored row that will not open does NOT fall back to `.env`,
    // so a message implying it might would send somebody away satisfied while
    // the deployment stays broken.
    const prisma = new FakeOperatorSettingsPrisma();
    prisma.sealInto('github.token', STORED);
    prisma.corrupt('github.token');

    const { settings } = await makeOperatorSettings({
      prisma,
      env: { GITHUB_TOKEN: 'ghp_theOldOneStillExported' },
    });

    const found = unreadableSecrets(settings);

    expect(found).toHaveLength(1);
    expect(found[0].key).toBe('github.token');
    expect(found[0].message).toContain('will NOT');
    expect(found[0].message).toContain('GITHUB_TOKEN');
    // And the credential it refused to fall back to is not in the message.
    expect(found[0].message).not.toContain('ghp_theOldOneStillExported');
  });

  it('says nothing when every stored credential opens', async () => {
    const prisma = new FakeOperatorSettingsPrisma();
    prisma.sealInto('models.anthropic.apiKey', 'sk-ant-api03-Fine');
    prisma.sealInto('models.openai.apiKey', 'sk-proj-AlsoFine');

    const { settings } = await makeOperatorSettings({ prisma });
    new UnreadableSecretsBootCheck(settings).onModuleInit();

    expect(errors).toEqual([]);
    expect(unreadableSecrets(settings)).toEqual([]);
  });

  it('says nothing about a credential that is simply not configured', async () => {
    const { settings } = await makeOperatorSettings({});
    expect(unreadableSecrets(settings)).toEqual([]);
  });

  it('never puts the credential in the message', async () => {
    // The house pattern. The value here is unreadable, so a leak would have to
    // come from the ENV layer the resolver is refusing to use — which is
    // exactly the field somebody would add while trying to be helpful.
    const prisma = new FakeOperatorSettingsPrisma();
    prisma.sealInto('models.openai.apiKey', 'sk-proj-Bq7Nm2Vz9Xd4Kt6Rw3Lp');
    prisma.corrupt('models.openai.apiKey');

    const { settings } = await makeOperatorSettings({
      prisma,
      env: { MODEL_OPENAI_API_KEY: 'sk-proj-Bq7Nm2Vz9Xd4Kt6Rw3Lp' },
    });

    const serialized = JSON.stringify(unreadableSecrets(settings));

    expect(serialized).not.toContain('sk-proj-Bq7Nm2Vz9Xd4Kt6Rw3Lp');
    for (let start = 0; start + 5 <= 22; start += 1) {
      expect(serialized).not.toContain(
        'sk-proj-Bq7Nm2Vz9Xd4Kt6Rw3Lp'.slice(start, start + 5),
      );
    }
    // Not vacuous: it did find the broken slot.
    expect(unreadableSecrets(settings)).toHaveLength(1);
  });

  it('holds its tongue when the overlay never loaded', async () => {
    // No rows were read, so every credential would report as absent rather
    // than broken. The overlay's own warning already covers that state, in its
    // own words, and a second message inventing a verdict would be wrong.
    const prisma = new FakeOperatorSettingsPrisma();
    prisma.down = 'the database is away';

    const { settings } = await makeOperatorSettings({ prisma });
    new UnreadableSecretsBootCheck(settings).onModuleInit();

    expect(errors).toEqual([]);
  });

  it('is driven off the registry, not a list of credentials somebody wrote down', async () => {
    // The guard that keeps this covering a credential added tomorrow. If the
    // scan were a hardcoded set, a new secret key would silently stop being
    // checked — the same failure `operator-settings-secret-leak.spec.ts`
    // guards with its own parity assertion.
    const prisma = new FakeOperatorSettingsPrisma();
    for (const key of [
      'github.token',
      'runners.claudeCodeLocal.oauthToken',
      'models.anthropic.apiKey',
      'models.openai.apiKey',
    ] as const) {
      prisma.sealInto(key, `secret-for-${key}`);
      prisma.corrupt(key);
    }

    const { settings } = await makeOperatorSettings({ prisma });

    expect(
      unreadableSecrets(settings)
        .map((s) => s.key)
        .sort(),
    ).toEqual([
      'github.token',
      'models.anthropic.apiKey',
      'models.openai.apiKey',
      'runners.claudeCodeLocal.oauthToken',
    ]);
  });
});
