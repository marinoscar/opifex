import { Logger } from '@nestjs/common';

import {
  FakeOperatorSettingsPrisma,
  TEST_ENCRYPTION_KEY,
  makeOperatorSettings,
} from '../../../test/fixtures/operator-settings.fixture';
import { ENCRYPTION_KEY_ENV_VAR, open } from '../../common/crypto/secret-box';
import { modelApiKeySettingKey } from '../../supervisor/invocation/supervisor-model.config';
import {
  LEGACY_MODEL_API_KEY_SETTING,
  LEGACY_MODEL_BASE_URL_SETTING,
  LegacyModelSettingsMigration,
  legacyModelEnvErrors,
  legacyModelSettingMoves,
  readStoredValue,
} from './legacy-model-settings.migration';
import type { OperatorSettingsService } from './operator-settings.service';

/**
 * The decrypt-then-re-encrypt move (#422).
 *
 * ## What these specs are really claiming
 *
 * That the credential SURVIVES, and that every way of failing to move it
 * leaves the operator with something they can act on rather than a slot that
 * looks configured and is not. `secret-box.ts` binds a ciphertext to its
 * setting key, so the interesting assertion is never "a row exists at the new
 * key" — it is "the row at the new key OPENS under the new key", which is the
 * one thing a `key = ...` rename would fail while looking like a success.
 */

const OLD_KEY = 'sk-ant-api03-Jm4Vn8Qz2Xb7Kd5Rt9Wp3Lc';

describe('LegacyModelSettingsMigration (#422)', () => {
  let errors: string[];
  let logs: string[];

  beforeEach(() => {
    errors = [];
    logs = [];
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: unknown) => {
        errors.push(String(message));
      });
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.env[ENCRYPTION_KEY_ENV_VAR] = TEST_ENCRYPTION_KEY;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env[ENCRYPTION_KEY_ENV_VAR];
  });

  async function build(options: {
    prisma?: FakeOperatorSettingsPrisma;
    env?: NodeJS.ProcessEnv;
  }): Promise<{
    migration: LegacyModelSettingsMigration;
    settings: OperatorSettingsService;
    prisma: FakeOperatorSettingsPrisma;
  }> {
    const { settings, prisma } = await makeOperatorSettings(options);
    return {
      migration: new LegacyModelSettingsMigration(settings, prisma.asPrisma()),
      settings,
      prisma,
    };
  }

  describe('the mapping', () => {
    it('sends the old value to the slot of the provider it was being used for', () => {
      // Not the DEFAULT provider's slot. The old key MEANT "the credential for
      // whichever provider the supervisor is set to", and preserving that
      // meaning is what makes the move invisible to an operator on OpenAI.
      expect(legacyModelSettingMoves('openai')).toEqual([
        {
          from: LEGACY_MODEL_API_KEY_SETTING,
          to: 'models.openai.apiKey',
          legacyEnvVar: 'SUPERVISOR_MODEL_API_KEY',
        },
        {
          from: LEGACY_MODEL_BASE_URL_SETTING,
          to: 'models.openai.baseUrl',
          legacyEnvVar: 'SUPERVISOR_MODEL_BASE_URL',
        },
      ]);
      expect(legacyModelSettingMoves('anthropic')[0].to).toBe(
        'models.anthropic.apiKey',
      );
    });
  });

  describe('a stored credential', () => {
    it('is re-encrypted under the new setting key and still decrypts', async () => {
      const prisma = new FakeOperatorSettingsPrisma();
      prisma.sealInto(LEGACY_MODEL_API_KEY_SETTING, OLD_KEY);

      const { migration, settings } = await build({ prisma });
      const outcomes = await migration.migrate();

      expect(outcomes).toContainEqual(
        expect.objectContaining({
          from: LEGACY_MODEL_API_KEY_SETTING,
          to: 'models.anthropic.apiKey',
          result: 'moved',
        }),
      );

      // The assertion that a `key = ...` UPDATE would fail: the row at the new
      // slot opens UNDER THE NEW SETTING KEY. A moved ciphertext would still
      // be a row, and the settings document would still say "configured".
      const row = prisma.rows.get('models.anthropic.apiKey');
      expect(row?.secretCiphertext).not.toBeNull();
      expect(
        open(
          {
            ciphertext: row?.secretCiphertext ?? '',
            iv: row?.secretIv ?? '',
            authTag: row?.secretAuthTag ?? '',
            keyVersion: row?.secretKeyVersion ?? -1,
          },
          'models.anthropic.apiKey',
        ),
      ).toEqual({ ok: true, plaintext: OLD_KEY });

      expect(settings.get('models.anthropic.apiKey')).toBe(OLD_KEY);
    });

    it('is a different ciphertext from the one it came from', async () => {
      // The point of the whole exercise. Identical bytes would mean the row
      // was copied rather than re-sealed, and a copied row cannot open.
      const prisma = new FakeOperatorSettingsPrisma();
      prisma.sealInto(LEGACY_MODEL_API_KEY_SETTING, OLD_KEY);
      const before = prisma.rows.get(
        LEGACY_MODEL_API_KEY_SETTING,
      )?.secretCiphertext;

      const { migration } = await build({ prisma });
      await migration.migrate();

      expect(
        prisma.rows.get('models.anthropic.apiKey')?.secretCiphertext,
      ).not.toBe(before);
    });

    it('leaves the superseded row deleted, so a second run does nothing', async () => {
      const prisma = new FakeOperatorSettingsPrisma();
      prisma.sealInto(LEGACY_MODEL_API_KEY_SETTING, OLD_KEY);

      const { migration, settings } = await build({ prisma });
      await migration.migrate();

      expect(prisma.rows.has(LEGACY_MODEL_API_KEY_SETTING)).toBe(false);
      expect(await migration.migrate()).toEqual([]);
      expect(settings.get('models.anthropic.apiKey')).toBe(OLD_KEY);
    });

    it('goes to the OpenAI slot on a deployment configured for OpenAI', async () => {
      const prisma = new FakeOperatorSettingsPrisma();
      prisma.sealInto(LEGACY_MODEL_API_KEY_SETTING, 'sk-proj-Qw8Nm3Vz6Kb2Rt');
      prisma.put('supervisor.model.provider', 'openai');

      const { migration, settings } = await build({ prisma });
      await migration.migrate();

      expect(settings.get('models.openai.apiKey')).toBe(
        'sk-proj-Qw8Nm3Vz6Kb2Rt',
      );
      expect(settings.get('models.anthropic.apiKey')).toBe('');
    });

    it('migrates a plain base URL row too', async () => {
      const prisma = new FakeOperatorSettingsPrisma();
      prisma.put(LEGACY_MODEL_BASE_URL_SETTING, 'https://gateway.test');

      const { migration, settings } = await build({ prisma });
      await migration.migrate();

      expect(settings.get('models.anthropic.baseUrl')).toBe(
        'https://gateway.test',
      );
      expect(prisma.rows.has(LEGACY_MODEL_BASE_URL_SETTING)).toBe(false);
    });
  });

  describe('when it cannot move the value', () => {
    it('never overwrites a credential already in the destination', async () => {
      // Two credentials and no way to know which the operator meant. Guessing
      // is how the wrong key ends up billed.
      const prisma = new FakeOperatorSettingsPrisma();
      prisma.sealInto(LEGACY_MODEL_API_KEY_SETTING, OLD_KEY);
      prisma.sealInto('models.anthropic.apiKey', 'sk-ant-api03-TheNewOne');

      const { migration, settings } = await build({ prisma });
      const outcomes = await migration.migrate();

      expect(outcomes[0].result).toBe('occupied');
      expect(settings.get('models.anthropic.apiKey')).toBe(
        'sk-ant-api03-TheNewOne',
      );
      // And the old row is still there, so nothing has been destroyed.
      expect(prisma.rows.has(LEGACY_MODEL_API_KEY_SETTING)).toBe(true);
      expect(errors.join('\n')).toContain(LEGACY_MODEL_API_KEY_SETTING);
    });

    it('reports a row that will not decrypt at error, and keeps it', async () => {
      // The arm the issue rules out doing silently. Nothing is written to the
      // new slot, nothing is deleted, and the operator is told at BOOT rather
      // than at the first model call.
      const prisma = new FakeOperatorSettingsPrisma();
      prisma.sealInto(LEGACY_MODEL_API_KEY_SETTING, OLD_KEY);
      prisma.corrupt(LEGACY_MODEL_API_KEY_SETTING);

      const { migration, settings } = await build({ prisma });
      const outcomes = await migration.migrate();

      expect(outcomes[0]).toMatchObject({ result: 'unreadable' });
      expect(prisma.rows.has('models.anthropic.apiKey')).toBe(false);
      expect(prisma.rows.has(LEGACY_MODEL_API_KEY_SETTING)).toBe(true);
      expect(settings.get('models.anthropic.apiKey')).toBe('');

      const said = errors.join('\n');
      expect(said).toContain('decrypt_failed');
      expect(said).toContain('models.anthropic.apiKey');
      expect(said).toContain('Re-enter the credential');
    });

    it('does not move anything when the encryption key is absent', async () => {
      // The other half of "loudly, not silently": with no data key the old row
      // cannot be read, and a migration that treated that as "no credential"
      // would delete the only evidence one was ever configured.
      const prisma = new FakeOperatorSettingsPrisma();
      prisma.sealInto(LEGACY_MODEL_API_KEY_SETTING, OLD_KEY);
      delete process.env[ENCRYPTION_KEY_ENV_VAR];

      const { migration } = await build({ prisma });
      const outcomes = await migration.migrate();

      expect(outcomes[0]).toMatchObject({
        result: 'unreadable',
      });
      expect(outcomes[0].detail).toContain('key_unavailable');
      expect(prisma.rows.has(LEGACY_MODEL_API_KEY_SETTING)).toBe(true);
      expect(prisma.rows.has('models.anthropic.apiKey')).toBe(false);
    });

    it('does nothing at all when the overlay never loaded', async () => {
      const prisma = new FakeOperatorSettingsPrisma();
      prisma.sealInto(LEGACY_MODEL_API_KEY_SETTING, OLD_KEY);
      const { migration } = await build({ prisma });

      prisma.down = 'the database is away';
      const { settings } = await makeOperatorSettings({ prisma });
      const offline = new LegacyModelSettingsMigration(
        settings,
        prisma.asPrisma(),
      );

      expect(await offline.migrate()).toEqual([]);
      // The one built while the database was up is unaffected by the above.
      expect(migration).toBeDefined();
    });
  });

  describe('the credential never appears anywhere it should not', () => {
    it('is absent from every outcome, every log line and every audit row', async () => {
      // The house pattern (`operator-settings-secret-leak.spec.ts`): seal a
      // known secret, serialize everything this component produced, and grep.
      // A field-by-field check tests the fields somebody thought of; the
      // failure worth catching is a credential carried by a message nobody
      // meant to build out of it.
      const prisma = new FakeOperatorSettingsPrisma();
      prisma.sealInto(LEGACY_MODEL_API_KEY_SETTING, OLD_KEY);

      const { migration } = await build({ prisma });
      const outcomes = await migration.migrate();

      const everything = JSON.stringify({
        outcomes,
        errors,
        logs,
        audits: prisma.audits,
      });

      expect(everything).not.toContain(OLD_KEY);
      // And no long RUN of it either, which is what fails on a partial leak
      // that a whole-string search would report as clean.
      for (let start = 0; start + 5 <= OLD_KEY.length; start += 1) {
        expect(everything).not.toContain(OLD_KEY.slice(start, start + 5));
      }
      // Not vacuous: the migration really did run and really did succeed.
      expect(outcomes[0].result).toBe('moved');
      expect(prisma.audits.length).toBeGreaterThan(0);
    });
  });

  describe('the superseded environment variable', () => {
    it('says nothing on the default provider, where it still works', () => {
      // No line, because there is nothing wrong: `SUPERVISOR_MODEL_API_KEY` IS
      // the default provider's `legacyEnvVar`, so an upgraded deployment that
      // has not edited `.env` still has a credential. The resolver says once
      // that the name has moved; a second message here would be noise.
      expect(
        legacyModelEnvErrors(
          { SUPERVISOR_MODEL_API_KEY: 'sk-ant-api03-StillWorks' },
          'anthropic',
        ),
      ).toEqual([]);
    });

    it('says so, by name, when a non-default provider is selected', () => {
      // The one case the compatibility shim deliberately does not cover, and
      // therefore the one an operator would otherwise experience as "I set the
      // key and nothing reads it".
      const said = legacyModelEnvErrors(
        { SUPERVISOR_MODEL_API_KEY: 'sk-proj-Nm3Kq8Vz' },
        'openai',
      ).join('\n');

      expect(said).toContain('SUPERVISOR_MODEL_API_KEY');
      expect(said).toContain('MODEL_OPENAI_API_KEY');
      expect(said).toContain('models.openai.apiKey');
      // Named, never printed — the rule `operator-settings.env-disagreement.ts`
      // states for the same class of message.
      expect(said).not.toContain('sk-proj-Nm3Kq8Vz');
    });

    it('treats an exported-but-empty variable as unset', () => {
      // `.env` files are full of `FOO=` written to mean "unset". Complaining
      // about one would report a credential that was never supplied.
      expect(
        legacyModelEnvErrors({ SUPERVISOR_MODEL_API_KEY: '  ' }, 'openai'),
      ).toEqual([]);
    });
  });
});

describe('readStoredValue (#422)', () => {
  const plain = {
    secretCiphertext: null,
    secretIv: null,
    secretAuthTag: null,
    secretKeyVersion: null,
  };

  it('reads a plain row', () => {
    expect(readStoredValue({ ...plain, value: 'https://x.test' }, 'k')).toEqual(
      { ok: true, value: 'https://x.test' },
    );
  });

  it('refuses a plain row holding something that is not a string', () => {
    expect(readStoredValue({ ...plain, value: 42 }, 'k')).toEqual({
      ok: false,
      reason: 'malformed_envelope',
    });
  });

  it('never returns a plaintext for a row it could not open', () => {
    // The type makes this hard to get wrong and the test says it anyway: the
    // failure arm carries no value, so no caller can reach a string that was
    // never decrypted.
    process.env[ENCRYPTION_KEY_ENV_VAR] = TEST_ENCRYPTION_KEY;
    try {
      const result = readStoredValue(
        {
          value: null,
          secretCiphertext: Buffer.from('nonsense').toString('base64'),
          secretIv: Buffer.alloc(12).toString('base64'),
          secretAuthTag: Buffer.alloc(16).toString('base64'),
          secretKeyVersion: 1,
        },
        modelApiKeySettingKey('anthropic'),
      );

      expect(result).toEqual({ ok: false, reason: 'decrypt_failed' });
      expect(result).not.toHaveProperty('value');
    } finally {
      delete process.env[ENCRYPTION_KEY_ENV_VAR];
    }
  });
});
