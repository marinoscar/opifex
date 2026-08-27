import { Logger } from '@nestjs/common';

import {
  FakeOperatorSettingsPrisma,
  TEST_ENCRYPTION_KEY,
  makeOperatorSettings,
} from '../../../test/fixtures/operator-settings.fixture';
import { ENCRYPTION_KEY_ENV_VAR } from '../../common/crypto/secret-box';
import { MASK, REVEALED_SUFFIX_LENGTH } from '../../common/crypto/redact';
import { operatorSettingsDocumentSchema } from './dto/operator-settings-response.dto';
import { OperatorSettingsController } from './operator-settings.controller';
import { SupervisorModelCatalogService } from '../../supervisor/invocation/model-catalog.service';
import type { OperatorProbesService } from './probes/operator-probes.service';
import { OPERATOR_SETTINGS } from './operator-settings.registry';

/**
 * THE test for this issue: seal a known secret, ask for the whole document,
 * serialize all of it, and prove the plaintext is not in there anywhere.
 *
 * ## Why it greps the serialized response instead of checking fields
 *
 * A field-by-field assertion tests the fields somebody thought of. The failure
 * this endpoint has to be incapable of is a secret arriving through a field
 * nobody thought of — a debugging aid left in, a spread that carried more than
 * intended, a new registry attribute that happens to hold the value. Only a
 * search of the entire serialized body catches those, and only that search
 * keeps catching them as the shape changes.
 *
 * ## Why it also refuses long substrings
 *
 * Asserting the absence of the whole plaintext alone would pass a response
 * that leaked all but the final character. The mask deliberately reveals the
 * last four characters (`redact.ts` argues why), so the bound is exactly that:
 * no run of the credential longer than the mask is allowed to appear. That
 * makes the test fail on a partial leak, which a whole-string search would
 * report as clean.
 */

/**
 * Long, distinctive, and shaped like the real thing. Length matters: above
 * `MIN_LENGTH_FOR_SUFFIX` the mask reveals a suffix, which is the case with
 * something to get wrong.
 */
const SECRETS = {
  'github.token': 'ghp_7Qk2Vx9ZmT4bWpL8nRcJ3sYd6HgzQ7m',
  'runners.claudeCodeLocal.oauthToken': 'sk-ant-oat01-Zt5Mq8XvB2wKjD7pHn4vB9x',
  'supervisor.model.apiKey': 'sk-ant-api03-Fj3Wb7Yn2QxMd8Kp5Tzk6Wd',
} as const;

/** Every contiguous run of `value` longer than `length`. */
function runsLongerThan(value: string, length: number): string[] {
  const runs: string[] = [];
  const size = length + 1;
  for (let start = 0; start + size <= value.length; start += 1) {
    runs.push(value.slice(start, start + size));
  }
  return runs;
}

describe('GET /api/operator-settings never returns a secret (#338)', () => {
  let prisma: FakeOperatorSettingsPrisma;
  let controller: OperatorSettingsController;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    process.env[ENCRYPTION_KEY_ENV_VAR] = TEST_ENCRYPTION_KEY;

    prisma = new FakeOperatorSettingsPrisma();
    for (const [key, plaintext] of Object.entries(SECRETS)) {
      prisma.sealInto(key as keyof typeof SECRETS, plaintext);
    }

    const { settings } = await makeOperatorSettings({
      prisma,
      // An environment that ALSO holds credentials, because the resolver's
      // env layer is a second place a value could come from — and a masking
      // bug that only covered the database layer would pass without this.
      env: {
        GITHUB_TOKEN: 'ghp_Nb8Ry4Ldx2Pv7WqJ5Zt3MgKc9HsdR4v',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-Cw6Kd3Jx8Zn5Rb2Vy7pT2j',
        SUPERVISOR_MODEL_API_KEY: 'sk-ant-api03-Ug9Tv2Mz5Xr8Bd4Nkw7Sc',
      },
    });

    controller = new OperatorSettingsController(
      settings,
      {} as unknown as OperatorProbesService,
      {} as unknown as SupervisorModelCatalogService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env[ENCRYPTION_KEY_ENV_VAR];
  });

  it('does not contain any stored secret anywhere in the serialized response', () => {
    const serialized = JSON.stringify(controller.list());

    for (const plaintext of Object.values(SECRETS)) {
      expect(serialized).not.toContain(plaintext);
    }
  });

  it('does not contain any long RUN of a stored secret either', () => {
    // The stronger claim, and the one that fails on a partial leak. See the
    // file header: the mask is allowed to reveal four characters and nothing
    // is allowed to reveal five.
    const serialized = JSON.stringify(controller.list());

    for (const plaintext of Object.values(SECRETS)) {
      for (const run of runsLongerThan(plaintext, REVEALED_SUFFIX_LENGTH)) {
        expect(serialized).not.toContain(run);
      }
    }
  });

  it('does not leak a secret supplied by the ENVIRONMENT either', async () => {
    // No rows at all this time, so all three secret keys resolve from `.env`.
    // A masking bug in the database branch alone would pass the tests above.
    const { settings } = await makeOperatorSettings({
      env: {
        GITHUB_TOKEN: 'ghp_Yh4Pm7Zq2Kx9Wd5Bn3Lr8Vt6Jcg1Su',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-Dq7Rz3Nv9Xb2Mk6Ty5wP8l',
        SUPERVISOR_MODEL_API_KEY: 'sk-ant-api03-Ke5Bw8Jn2Vx7Zd4Rq9Ms3T',
      },
    });
    const envController = new OperatorSettingsController(
      settings,
      {} as unknown as OperatorProbesService,
      {} as unknown as SupervisorModelCatalogService,
    );

    const serialized = JSON.stringify(envController.list());

    for (const plaintext of [
      'ghp_Yh4Pm7Zq2Kx9Wd5Bn3Lr8Vt6Jcg1Su',
      'sk-ant-oat01-Dq7Rz3Nv9Xb2Mk6Ty5wP8l',
      'sk-ant-api03-Ke5Bw8Jn2Vx7Zd4Rq9Ms3T',
    ]) {
      expect(serialized).not.toContain(plaintext);
      for (const run of runsLongerThan(plaintext, REVEALED_SUFFIX_LENGTH)) {
        expect(serialized).not.toContain(run);
      }
    }
  });

  it('strips a value the builder was tricked into attaching to a secret entry', () => {
    // The "field nobody thought about", simulated. If the response schema's
    // secret arm ever gained a permissive shape — or the parse were removed —
    // this is what would get through. It asserts the STRIP, not the builder:
    // the builder is code somebody will edit, and the schema is the thing that
    // makes the guarantee survive the edit.
    const document = controller.list();
    const secret = document.settings.find((entry) => entry.secret === true);
    expect(secret).toBeDefined();
    expect(secret).not.toHaveProperty('value');

    const smuggled = {
      ...document,
      settings: document.settings.map((entry) =>
        entry.secret
          ? { ...entry, debugValue: SECRETS['github.token'] }
          : entry,
      ),
    };

    const stripped = JSON.stringify(
      operatorSettingsDocumentSchema.parse(smuggled),
    );

    expect(stripped).not.toContain(SECRETS['github.token']);
    expect(JSON.stringify(smuggled)).toContain(SECRETS['github.token']);
  });

  describe('what it returns INSTEAD of the value', () => {
    it('says a stored secret is configured, from the database, with a hint', () => {
      const entry = controller
        .list()
        .settings.find((item) => item.key === 'github.token');

      expect(entry).toMatchObject({
        secret: true,
        configured: true,
        source: 'database',
        hint: `${MASK}zQ7m`,
        updatedAt: '2026-08-20T09:00:00.000Z',
      });
    });

    it('reveals at most the last four characters, and only as a hint', () => {
      const entry = controller
        .list()
        .settings.find((item) => item.key === 'supervisor.model.apiKey');

      const hint = (entry as { hint: string }).hint;
      expect(hint.startsWith(MASK)).toBe(true);
      expect(hint.length).toBe(MASK.length + REVEALED_SUFFIX_LENGTH);
    });

    it('reports a secret that will not decrypt as unconfigured, with the error', async () => {
      // #339's rule, surfaced: the resolver refuses to fall back to the
      // environment for a broken ciphertext, so "not configured" is the truth
      // and the `error` is what stops the UI rendering that as "nobody has set
      // this yet".
      const broken = new FakeOperatorSettingsPrisma();
      broken.sealInto('github.token', SECRETS['github.token']);
      broken.corrupt('github.token');

      const { settings } = await makeOperatorSettings({
        prisma: broken,
        env: { GITHUB_TOKEN: 'ghp_Ax2Nq7Vd5Zm8Kb3Wr6Jt9Pc4Lhu5S' },
      });
      const brokenController = new OperatorSettingsController(
        settings,
        {} as unknown as OperatorProbesService,
        {} as unknown as SupervisorModelCatalogService,
      );
      const document = brokenController.list();
      const entry = document.settings.find(
        (item) => item.key === 'github.token',
      );

      expect(entry).toMatchObject({
        secret: true,
        configured: false,
        hint: null,
        error: { reason: 'decrypt_failed' },
      });
      // And the credential it refused to fall back to is not in the body
      // either, in any form.
      expect(JSON.stringify(document)).not.toContain(
        'ghp_Ax2Nq7Vd5Zm8Kb3Wr6Jt9Pc4Lhu5S',
      );
    });

    it('marks an unconfigured secret slot as such rather than masking nothing', async () => {
      const { settings } = await makeOperatorSettings({ env: {} });
      const empty = new OperatorSettingsController(
        settings,
        {} as unknown as OperatorProbesService,
        {} as unknown as SupervisorModelCatalogService,
      );

      const entry = empty
        .list()
        .settings.find((item) => item.key === 'github.token');

      // `null`, not `'********'`: a mask over an empty slot reads as "there is
      // something here you may not see", which is the opposite of true.
      expect(entry).toMatchObject({
        secret: true,
        configured: false,
        hint: null,
        source: 'default',
      });
    });
  });

  it('covers every key the registry marks secret, not a hardcoded three', () => {
    // Guards the canary list above: a fourth secret key added to the registry
    // and not added to `SECRETS` would make every assertion in this file
    // silently stop covering it.
    const declared = Object.entries(OPERATOR_SETTINGS)
      .filter(([, definition]) => definition.secret)
      .map(([key]) => key)
      .sort();

    expect(declared).toEqual(Object.keys(SECRETS).sort());
  });
});
