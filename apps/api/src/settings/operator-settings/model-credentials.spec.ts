import { Logger } from '@nestjs/common';

import {
  FakeOperatorSettingsPrisma,
  TEST_ENCRYPTION_KEY,
  makeOperatorSettings,
} from '../../../test/fixtures/operator-settings.fixture';
import { ENCRYPTION_KEY_ENV_VAR } from '../../common/crypto/secret-box';
import { resolveSupervisorModelConfig } from '../../supervisor/invocation/supervisor-model.config';

/**
 * Two provider credentials, held at the same time (#422, epic #419).
 *
 * ## What the issue actually asks to be proven
 *
 * Not "there are two keys in the registry" — the registry spec covers the
 * shape. This is about the property an operator experiences: **switching a
 * consumer's provider neither requires re-entering a credential nor destroys
 * one.** That is a statement about the write path, the overlay and the
 * per-call resolution together, so it is asserted against the REAL service
 * over a stand-in table rather than against the test double, which would prove
 * only that a `Map` holds two entries.
 *
 * The bug it pins is precise and was live on the deployment: provider
 * `anthropic` with an `sk-ant-…` key, selecting OpenAI, and the only way
 * forward being to overwrite the Anthropic key.
 */

const ANTHROPIC_KEY = 'sk-ant-api03-Wd7Kq2Vn9Zm4Bt6Rx3Lp';
const OPENAI_KEY = 'sk-proj-Hj5Nq8Vz2Xb7Kd4Rw9Mt3Lc';

describe('model credentials are held independently (#422)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    process.env[ENCRYPTION_KEY_ENV_VAR] = TEST_ENCRYPTION_KEY;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env[ENCRYPTION_KEY_ENV_VAR];
  });

  it('stores both keys at once, each sealed under its own slot', async () => {
    const { settings, prisma } = await makeOperatorSettings({});

    await settings.set('models.anthropic.apiKey', ANTHROPIC_KEY, null);
    await settings.set('models.openai.apiKey', OPENAI_KEY, null);

    expect(settings.get('models.anthropic.apiKey')).toBe(ANTHROPIC_KEY);
    expect(settings.get('models.openai.apiKey')).toBe(OPENAI_KEY);

    // Two rows, two ciphertexts, neither of which is the other. Same-bytes
    // would mean one slot was storing the other's blob, which `secret-box.ts`
    // makes unopenable — and which is the whole reason the slots are separate
    // rows rather than one field that gets overwritten.
    const a = prisma.rows.get('models.anthropic.apiKey');
    const b = prisma.rows.get('models.openai.apiKey');
    expect(a?.secretCiphertext).toBeTruthy();
    expect(b?.secretCiphertext).toBeTruthy();
    expect(a?.secretCiphertext).not.toBe(b?.secretCiphertext);
  });

  it('switching the supervisor between providers destroys neither key', async () => {
    // #422's second acceptance criterion, and the live deployment's exact
    // situation. Everything here is a real write through the real service.
    const { settings, prisma } = await makeOperatorSettings({});
    await settings.set('models.anthropic.apiKey', ANTHROPIC_KEY, null);
    await settings.set('models.openai.apiKey', OPENAI_KEY, null);
    await settings.set('supervisor.model.name', 'a-model', null);

    expect(resolveSupervisorModelConfig(settings)).toMatchObject({
      provider: 'anthropic',
      apiKey: ANTHROPIC_KEY,
      baseUrl: 'https://api.anthropic.com',
    });

    await settings.set('supervisor.model.provider', 'openai', null);

    expect(resolveSupervisorModelConfig(settings)).toMatchObject({
      provider: 'openai',
      apiKey: OPENAI_KEY,
      baseUrl: 'https://api.openai.com',
    });

    // Back again, with nothing re-entered in between — which is the sentence
    // the issue writes: "switching provider means overwriting, and the
    // previous key is gone".
    await settings.set('supervisor.model.provider', 'anthropic', null);
    expect(resolveSupervisorModelConfig(settings).apiKey).toBe(ANTHROPIC_KEY);

    expect(prisma.rows.has('models.anthropic.apiKey')).toBe(true);
    expect(prisma.rows.has('models.openai.apiKey')).toBe(true);
  });

  it('clearing one leaves the other exactly where it was', async () => {
    const { settings } = await makeOperatorSettings({});
    await settings.set('models.anthropic.apiKey', ANTHROPIC_KEY, null);
    await settings.set('models.openai.apiKey', OPENAI_KEY, null);

    await settings.clear('models.openai.apiKey', null);

    expect(settings.get('models.openai.apiKey')).toBe('');
    expect(settings.get('models.anthropic.apiKey')).toBe(ANTHROPIC_KEY);
  });

  it('gives each provider its own base URL override', async () => {
    // A proxy is a proxy FOR A VENDOR. One shared override would send the
    // OpenAI key to the Anthropic gateway the moment a consumer switched —
    // the same coupling as the key, one field over.
    const { settings } = await makeOperatorSettings({});
    await settings.set(
      'models.anthropic.baseUrl',
      'https://anthropic.gateway.test',
      null,
    );

    expect(resolveSupervisorModelConfig(settings).baseUrl).toBe(
      'https://anthropic.gateway.test',
    );

    await settings.set('supervisor.model.provider', 'openai', null);

    // Untouched, so it falls back to OpenAI's own endpoint rather than
    // inheriting a gateway that has nothing to do with it.
    expect(resolveSupervisorModelConfig(settings).baseUrl).toBe(
      'https://api.openai.com',
    );
  });

  it('reads both from the environment at once', async () => {
    // `.env` remains a working floor for BOTH keys, which is the criterion
    // that matters while the Credentials UI (#349) has not shipped.
    const { settings } = await makeOperatorSettings({
      env: {
        MODEL_ANTHROPIC_API_KEY: ANTHROPIC_KEY,
        MODEL_OPENAI_API_KEY: OPENAI_KEY,
      },
    });

    expect(settings.resolve('models.anthropic.apiKey')).toMatchObject({
      value: ANTHROPIC_KEY,
      source: 'env',
    });
    expect(settings.resolve('models.openai.apiKey')).toMatchObject({
      value: OPENAI_KEY,
      source: 'env',
    });
  });

  describe('the superseded environment variable', () => {
    it('still supplies the default provider’s slot', async () => {
      // An upgraded deployment that has not edited `.env` keeps its
      // supervisor. Deleting the read would have been a silent outage at the
      // restart that picked up the rename.
      const { settings } = await makeOperatorSettings({
        env: { SUPERVISOR_MODEL_API_KEY: ANTHROPIC_KEY },
      });

      expect(settings.get('models.anthropic.apiKey')).toBe(ANTHROPIC_KEY);
      expect(resolveSupervisorModelConfig(settings).apiKey).toBe(ANTHROPIC_KEY);
    });

    it('never supplies another provider’s slot', async () => {
      // The reason it maps to exactly one slot: an `sk-ant-` credential in the
      // OpenAI slot would be posted to OpenAI on the next provider switch,
      // which is the confusion this issue removes rather than relocates.
      const { settings } = await makeOperatorSettings({
        env: { SUPERVISOR_MODEL_API_KEY: ANTHROPIC_KEY },
      });

      expect(settings.get('models.openai.apiKey')).toBe('');
    });

    it('loses to the current name when both are set', async () => {
      const { settings } = await makeOperatorSettings({
        env: {
          MODEL_ANTHROPIC_API_KEY: ANTHROPIC_KEY,
          SUPERVISOR_MODEL_API_KEY: 'sk-ant-api03-TheStaleOne',
        },
      });

      expect(settings.get('models.anthropic.apiKey')).toBe(ANTHROPIC_KEY);
    });

    it('loses to a stored row, like any other environment value', async () => {
      const prisma = new FakeOperatorSettingsPrisma();
      prisma.sealInto('models.anthropic.apiKey', ANTHROPIC_KEY);

      const { settings } = await makeOperatorSettings({
        prisma,
        env: { SUPERVISOR_MODEL_API_KEY: 'sk-ant-api03-TheStaleOne' },
      });

      expect(settings.resolve('models.anthropic.apiKey')).toMatchObject({
        value: ANTHROPIC_KEY,
        source: 'database',
      });
    });
  });
});
