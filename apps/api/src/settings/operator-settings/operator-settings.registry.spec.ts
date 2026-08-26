import {
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_GROUPS,
  OPERATOR_SETTING_KEYS,
  OPERATOR_SETTING_KINDS,
  RELOAD_SEMANTICS,
  isOperatorSettingKey,
  operatorSettingEntries,
  parseOperatorSetting,
  type AnyOperatorSettingDefinition,
  type OperatorSettingKey,
} from './operator-settings.registry';

/**
 * One representative value for a key, in both forms it can arrive in.
 *
 * Generated from the definition rather than hand-written per key, for one
 * reason: a hand-written table is a table someone adding a key forgets to
 * extend, and the parity assertion would then silently stop covering the newest
 * key — which is the same "green for the wrong reason" failure the test double
 * exists to prevent, one layer down.
 */
interface ParityCase {
  readonly what: string;
  /** The form a database JSON value arrives in (#336, #339). */
  readonly json: unknown;
  /** The form an environment variable arrives in. */
  readonly env: string;
}

function clamp(value: number, def: AnyOperatorSettingDefinition): number {
  const min = def.min ?? Number.MIN_SAFE_INTEGER;
  const max = def.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(value, min), max);
}

/** An integer inside the declared bounds that is NOT the declared default. */
function otherInteger(def: AnyOperatorSettingDefinition): number {
  const current = typeof def.default === 'number' ? def.default : null;
  if (current === null) return clamp(2, def);

  const up = clamp(current + 1, def);
  return up === current ? clamp(current - 1, def) : up;
}

function otherString(def: AnyOperatorSettingDefinition): string {
  if (def.format === 'url') return 'https://parity.example.test/base';
  if (def.format === 'email') return 'parity@example.test';
  const current = typeof def.default === 'string' ? def.default : '';
  return current === '' ? 'parity-value' : `${current}-parity`;
}

function parityCases(def: AnyOperatorSettingDefinition): ParityCase[] {
  switch (def.kind) {
    case 'boolean': {
      const flipped = !(def.default as boolean);
      return [
        {
          what: `boolean ${String(flipped)}`,
          json: flipped,
          env: String(flipped),
        },
        {
          what: `boolean ${String(!flipped)}`,
          json: !flipped,
          env: String(!flipped),
        },
      ];
    }
    case 'integer': {
      const value = otherInteger(def);
      const cases: ParityCase[] = [
        { what: `integer ${value}`, json: value, env: String(value) },
      ];
      if (def.nullable) {
        cases.push({ what: 'null', json: null, env: 'null' });
      }
      return cases;
    }
    case 'enum': {
      const values = def.values ?? [];
      const value = values.find((candidate) => candidate !== def.default);
      if (value === undefined) {
        throw new Error('an enum setting needs at least two legal values');
      }
      return [{ what: `enum ${value}`, json: value, env: value }];
    }
    case 'string': {
      const value = otherString(def);
      return [{ what: `string ${value}`, json: value, env: value }];
    }
  }
}

describe('operator settings registry', () => {
  const entries = operatorSettingEntries();

  it('declares at least the keys epic #332 puts in scope', () => {
    // A floor rather than an exact list: adding a key is expected, silently
    // losing a group is not.
    expect(entries.length).toBeGreaterThanOrEqual(30);
    for (const group of OPERATOR_SETTING_GROUPS) {
      expect(entries.some(([, def]) => def.group === group)).toBe(true);
    }
  });

  describe.each(entries)('%s', (key, def) => {
    it('populates every registry field', () => {
      expect(def.envVar).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(OPERATOR_SETTING_KINDS).toContain(def.kind);
      expect(RELOAD_SEMANTICS).toContain(def.reload);
      expect(OPERATOR_SETTING_GROUPS).toContain(def.group);
      expect(typeof def.secret).toBe('boolean');
      expect(def.label.length).toBeGreaterThan(0);
      // Long enough to say what the setting does and what changing it costs.
      // A one-word `help` renders as a label twice over and tells an operator
      // nothing they could not already see.
      expect(def.help.length).toBeGreaterThan(40);
    });

    it('declares a default that is itself a legal value', () => {
      const parsed = parseOperatorSetting(key, def.default);
      expect(parsed).toEqual({ ok: true, value: def.default });
    });

    // ---------------------------------------------------------------------
    // THE PARITY ASSERTION (#335's acceptance criterion)
    //
    // Structured so it cannot pass vacuously. Every case asserts that BOTH
    // forms parsed successfully and that each produced the specific expected
    // value — not merely that the two results are equal to each other, which
    // two identical parse FAILURES would also satisfy.
    // ---------------------------------------------------------------------
    describe.each(parityCases(def))(
      'resolves the env string and the JSON value identically ($what)',
      (parity: ParityCase) => {
        it('parses both forms to the same declared type', () => {
          const fromJson = parseOperatorSetting(key, parity.json);
          const fromEnv = parseOperatorSetting(key, parity.env);

          expect(fromJson).toEqual({ ok: true, value: parity.json });
          expect(fromEnv).toEqual({ ok: true, value: parity.json });
          expect(fromEnv).toEqual(fromJson);
        });
      },
    );

    it('has at least one parity case that is not simply the default', () => {
      // The anti-vacuity guard for the block above: if every representative
      // value happened to equal the declared default, the parity assertion
      // would hold even for a schema that ignored its input entirely.
      const cases = parityCases(def);
      expect(cases.some((parity) => parity.json !== def.default)).toBe(true);
    });

    it('marks credentials secret', () => {
      // Catches the shape of mistake that matters most in this registry: a
      // credential added later without `secret: true`, which #337 would then
      // neither encrypt nor redact.
      // Anchored on whole underscore-separated words: SUPERVISOR_MODEL_
      // DEFAULT_MAX_TOKENS ends in TOKENS and is a token BUDGET, not a
      // credential.
      if (
        /(^|_)(TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL)(_|$)/.test(def.envVar)
      ) {
        expect(def.secret).toBe(true);
      }
    });

    it('explains a restart when it demands one', () => {
      if (def.reload === 'restart') {
        expect(def.help.toLowerCase()).toContain('restart');
      }
    });
  });

  it('uses each environment variable exactly once', () => {
    const envVars = entries.map(([, def]) => def.envVar);
    expect(new Set(envVars).size).toBe(envVars.length);
  });

  describe('keys that must never be in this registry', () => {
    // -----------------------------------------------------------------------
    // THIS TEST IS A GUARD, NOT A DESCRIPTION.
    //
    // `budget/hard-spend-ceiling.ts:5-20` reads the ceiling from `process.env`
    // once, into `readonly` fields with no setter anywhere, SPECIFICALLY so
    // that no runtime path to a higher ceiling exists — VISION §8, "a limit an
    // agent can raise is not a limit". Adding any of these four here would
    // give a settings endpoint a path to that limit and quietly reverse a
    // guarantee the system states in prose.
    //
    // They DO become editable, in #345, deliberately, with an ADR and only
    // once both containment barriers land (#334's environment scrub and #346's
    // refusal of non-interactive credentials). If you are here because this
    // test failed: that is the conversation to have, not a line to delete.
    // -----------------------------------------------------------------------
    const forbidden = [
      'OPIFEX_HARD_SPEND_CEILING_USD',
      'OPIFEX_HARD_SPEND_CEILING_WINDOW_DAYS',
      'SUPERVISOR_HARD_SPEND_CEILING_USD',
      'SUPERVISOR_HARD_SPEND_CEILING_WINDOW_DAYS',
    ];

    it.each(forbidden)('does not declare %s', (envVar) => {
      expect(entries.map(([, def]) => def.envVar)).not.toContain(envVar);
      expect(OPERATOR_SETTING_KEYS).not.toContain(envVar);
    });

    it('declares no spend ceiling under any other name either', () => {
      for (const [key, def] of entries) {
        expect(def.envVar).not.toContain('SPEND_CEILING');
        expect(key.toLowerCase()).not.toContain('spendceiling');
      }
    });

    it('declares nothing epic #332 puts out of scope', () => {
      const outOfScope = [
        'POSTGRES_',
        'JWT_',
        'COOKIE_SECRET',
        'GOOGLE_',
        'AWS_',
        'S3_',
        'OTEL_',
        'UPTRACE_',
        'LOG_LEVEL',
        'DEVICE_',
        'STORAGE_',
        'VAPID_',
        'PORT',
        'APP_URL',
        'INITIAL_ADMIN_EMAIL',
      ];

      for (const [, def] of entries) {
        for (const prefix of outOfScope) {
          expect(def.envVar.startsWith(prefix)).toBe(false);
        }
      }
    });
  });

  describe('isOperatorSettingKey', () => {
    it('recognises a declared key', () => {
      expect(isOperatorSettingKey('dispatch.enabled')).toBe(true);
    });

    it('rejects a near miss', () => {
      expect(isOperatorSettingKey('dispatch.enable')).toBe(false);
      expect(isOperatorSettingKey('toString')).toBe(false);
    });
  });

  describe('parsing rules the whole registry shares', () => {
    it('reproduces the === true idiom for a switch that defaults off', () => {
      // `configuration.ts` compares GITHUB_WRITES_ENABLED with === 'true', so
      // every unrecognised spelling means off today. The registry keeps that
      // by rejecting the value and falling back to the declared default.
      for (const raw of ['TRUE', 'yes', '1', 'on', 'enabled']) {
        expect(parseOperatorSetting('github.writesEnabled', raw).ok).toBe(
          false,
        );
      }
      expect(parseOperatorSetting('github.writesEnabled', 'true')).toEqual({
        ok: true,
        value: true,
      });
    });

    it('reproduces the !== false idiom for the one switch that defaults on', () => {
      // SUPERVISOR_STAND_DOWN_WHEN_BLOCKED is compared !== 'false' today, so
      // 'FALSE' and 'no' mean ON. Same rule as above, opposite default — one
      // parsing rule reproducing two contradictory call-site idioms.
      for (const raw of ['FALSE', 'no', '0', 'off']) {
        expect(
          parseOperatorSetting('supervisor.standDownWhenBlocked', raw).ok,
        ).toBe(false);
      }
      expect(
        parseOperatorSetting('supervisor.standDownWhenBlocked', 'false'),
      ).toEqual({ ok: true, value: false });
      expect(OPERATOR_SETTINGS['supervisor.standDownWhenBlocked'].default).toBe(
        true,
      );
    });

    it('refuses a number that parseInt would have silently truncated', () => {
      // `parseInt('10 agents', 10)` is 10 and `parseInt('lots', 10)` is NaN.
      // A NaN timeout is how a setting stops being a setting without anyone
      // noticing, so neither is accepted.
      expect(parseOperatorSetting('github.maxRetries', '3 retries').ok).toBe(
        false,
      );
      expect(parseOperatorSetting('github.maxRetries', 'lots').ok).toBe(false);
      expect(parseOperatorSetting('github.maxRetries', '2.5').ok).toBe(false);
      expect(parseOperatorSetting('github.maxRetries', 2.5).ok).toBe(false);
    });

    it('enforces the declared bounds on both forms', () => {
      expect(
        parseOperatorSetting('runners.claudeCodeLocal.maxConcurrency', 0).ok,
      ).toBe(false);
      expect(
        parseOperatorSetting('runners.claudeCodeLocal.maxConcurrency', '0').ok,
      ).toBe(false);
    });

    it('tolerates whitespace around a value from either source', () => {
      expect(parseOperatorSetting('dispatch.enabled', '  true  ')).toEqual({
        ok: true,
        value: true,
      });
      expect(parseOperatorSetting('dispatch.maxConcurrent', ' 4 ')).toEqual({
        ok: true,
        value: 4,
      });
    });

    it('rejects a value of the wrong JSON type outright', () => {
      // The database column is JSON, so a wrong type is reachable. It must be
      // refused rather than coerced: `Boolean('false')` is `true`, and that
      // coercion is exactly the class of bug this registry exists to close.
      expect(parseOperatorSetting('dispatch.enabled', 1).ok).toBe(false);
      expect(parseOperatorSetting('dispatch.enabled', null).ok).toBe(false);
      expect(parseOperatorSetting('github.maxRetries', true).ok).toBe(false);
      expect(parseOperatorSetting('github.userAgent', 42).ok).toBe(false);
    });

    it('accepts null only where null is a declared value', () => {
      expect(parseOperatorSetting('dispatch.maxConcurrent', null)).toEqual({
        ok: true,
        value: null,
      });
      expect(parseOperatorSetting('dispatch.maxConcurrent', 'null')).toEqual({
        ok: true,
        value: null,
      });
      expect(parseOperatorSetting('github.requestTimeoutMs', null).ok).toBe(
        false,
      );
      expect(parseOperatorSetting('github.requestTimeoutMs', 'null').ok).toBe(
        false,
      );
    });

    it('validates the formats it claims to validate', () => {
      expect(parseOperatorSetting('github.apiBaseUrl', 'not-a-url').ok).toBe(
        false,
      );
      expect(
        parseOperatorSetting('runners.claudeCodeLocal.committerEmail', 'nobody')
          .ok,
      ).toBe(false);
      // Empty is how "no fallback configured" is expressed, and must stay
      // expressible even though the field is a URL.
      expect(
        parseOperatorSetting('notifications.fallbackWebhookUrl', ''),
      ).toEqual({ ok: true, value: '' });
    });

    it('rejects a permission mode the CLI would reject', () => {
      const key: OperatorSettingKey = 'runners.claudeCodeLocal.permissionMode';
      expect(parseOperatorSetting(key, 'bypassPermissions').ok).toBe(true);
      expect(parseOperatorSetting(key, 'yolo').ok).toBe(false);
    });
  });
});
