import {
  validateEnv,
  SECRET_MIN_LENGTH,
  DEFAULT_POSTGRES_PASSWORD,
} from './env.validation';

/**
 * Unit coverage for the boot-time environment gate (#278).
 *
 * `validateEnv` is wired into `ConfigModule.forRoot({ validate })` in
 * `app.module.ts`, and its return value REPLACES the environment the
 * `ConfigService` is built from (see the doc comment on `envSchema`). That
 * makes the passthrough case below the single most important assertion in
 * this file: a strict schema would silently drop every variable it doesn't
 * name, and `AdminBootstrapService` would stop seeing `INITIAL_ADMIN_EMAIL`
 * with no error anywhere.
 */
describe('validateEnv', () => {
  const validSecret = 'a'.repeat(SECRET_MIN_LENGTH);
  const shortSecret = 'a'.repeat(SECRET_MIN_LENGTH - 1);

  it('throws when JWT_SECRET is unset', () => {
    expect(() => validateEnv({})).toThrow(/JWT_SECRET/);
  });

  it('throws when JWT_SECRET is under the minimum length', () => {
    expect(() => validateEnv({ JWT_SECRET: shortSecret })).toThrow(
      /JWT_SECRET/,
    );
  });

  it('passes when JWT_SECRET is exactly the minimum length (boundary)', () => {
    expect(validSecret).toHaveLength(SECRET_MIN_LENGTH);

    expect(() => validateEnv({ JWT_SECRET: validSecret })).not.toThrow();
  });

  it('throws when COOKIE_SECRET is set but under the minimum length', () => {
    expect(() =>
      validateEnv({ JWT_SECRET: validSecret, COOKIE_SECRET: shortSecret }),
    ).toThrow(/COOKIE_SECRET/);
  });

  it('passes when COOKIE_SECRET is unset — it is optional', () => {
    expect(() => validateEnv({ JWT_SECRET: validSecret })).not.toThrow();
  });

  it('passes when COOKIE_SECRET clears the same floor as JWT_SECRET', () => {
    expect(() =>
      validateEnv({ JWT_SECRET: validSecret, COOKIE_SECRET: validSecret }),
    ).not.toThrow();
  });

  it('reports both problems at once, not just the first', () => {
    // An operator fixing a fresh deployment should not have to restart the
    // container to discover the second missing variable — see the doc
    // comment on validateEnv.
    let message = '';
    try {
      validateEnv({ JWT_SECRET: shortSecret, COOKIE_SECRET: shortSecret });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('JWT_SECRET');
    expect(message).toContain('COOKIE_SECRET');
  });

  it('passes unrelated variables through unchanged (.loose() is load-bearing)', () => {
    // validateEnv's return value replaces process.env for ConfigService.
    // AdminBootstrapService reads INITIAL_ADMIN_EMAIL straight off
    // ConfigService — a strict schema would silently drop it here and the
    // first admin would stop being bootstrapped, with no error anywhere.
    const result = validateEnv({
      JWT_SECRET: validSecret,
      INITIAL_ADMIN_EMAIL: 'admin@example.com',
      NODE_ENV: 'production',
      // Required since #299 because NODE_ENV is 'production' here. This case
      // is about passthrough, not about the database rule — without it the
      // fixture would fail for an unrelated reason and stop testing what it
      // is named for.
      POSTGRES_PASSWORD: 'a-real-password',
    });

    expect(result.INITIAL_ADMIN_EMAIL).toBe('admin@example.com');
    expect(result.NODE_ENV).toBe('production');
  });
});

/**
 * Unit coverage for the production-only POSTGRES_PASSWORD floor (#299). See
 * the doc comments on `productionDatabasePassword` and
 * `productionOnlyProblems` in `env.validation.ts` for why this is gated on
 * `NODE_ENV === 'production'` at all, and why the literal-default rejection
 * — not mere presence — is the check that does the work.
 */
describe('validateEnv — POSTGRES_PASSWORD in production (#299)', () => {
  const validSecret = 'a'.repeat(SECRET_MIN_LENGTH);
  const shortSecret = 'a'.repeat(SECRET_MIN_LENGTH - 1);

  it('rejects an unset POSTGRES_PASSWORD when NODE_ENV is production', () => {
    expect(() =>
      validateEnv({ JWT_SECRET: validSecret, NODE_ENV: 'production' }),
    ).toThrow(/POSTGRES_PASSWORD/);
  });

  it('rejects an empty POSTGRES_PASSWORD when NODE_ENV is production', () => {
    expect(() =>
      validateEnv({
        JWT_SECRET: validSecret,
        NODE_ENV: 'production',
        POSTGRES_PASSWORD: '',
      }),
    ).toThrow(/POSTGRES_PASSWORD/);
  });

  it('rejects the literal default POSTGRES_PASSWORD when NODE_ENV is production', () => {
    // This is the check that does the actual work: presence alone would be
    // satisfied by `cp .env.example .env`, which ships this exact value —
    // see the doc comment on `productionDatabasePassword`.
    expect(() =>
      validateEnv({
        JWT_SECRET: validSecret,
        NODE_ENV: 'production',
        POSTGRES_PASSWORD: DEFAULT_POSTGRES_PASSWORD,
      }),
    ).toThrow(/POSTGRES_PASSWORD/);
  });

  it('accepts a real POSTGRES_PASSWORD when NODE_ENV is production', () => {
    expect(() =>
      validateEnv({
        JWT_SECRET: validSecret,
        NODE_ENV: 'production',
        POSTGRES_PASSWORD: 'a-real-password-nobody-guessed',
      }),
    ).not.toThrow();
  });

  describe.each([
    ['development', 'development'],
    ['test', 'test'],
    ['NODE_ENV absent entirely', undefined],
  ])('when NODE_ENV is %s', (_label, nodeEnv) => {
    function configFor(overrides: Record<string, unknown> = {}) {
      const config: Record<string, unknown> = {
        JWT_SECRET: validSecret,
        ...overrides,
      };

      if (nodeEnv !== undefined) {
        config.NODE_ENV = nodeEnv;
      }

      return config;
    }

    it('does not require POSTGRES_PASSWORD', () => {
      expect(() => validateEnv(configFor())).not.toThrow();
    });

    it('accepts the literal default POSTGRES_PASSWORD — that is the whole point of gating on production', () => {
      expect(() =>
        validateEnv(
          configFor({ POSTGRES_PASSWORD: DEFAULT_POSTGRES_PASSWORD }),
        ),
      ).not.toThrow();
    });
  });

  it('reads NODE_ENV off the passed config object, not process.env', () => {
    // `ConfigModule.forRoot` hands `validate` the merge of an .env file's
    // variables with `process.env`, so a NODE_ENV that only exists in the
    // former must still be seen here — see the doc comment on
    // `productionOnlyProblems`. Proven by deliberately NOT touching
    // process.env at all: the ambient environment stays whatever this test
    // file already runs under (never 'production' — see test/setup.ts, which
    // forces NODE_ENV=test), and the production branch still fires because it
    // is present in the argument.
    expect(process.env.NODE_ENV).not.toBe('production');

    expect(() =>
      validateEnv({ JWT_SECRET: validSecret, NODE_ENV: 'production' }),
    ).toThrow(/POSTGRES_PASSWORD/);

    // Confirms the call above never mutated the process it ran in.
    expect(process.env.NODE_ENV).not.toBe('production');
  });

  it('reports both JWT_SECRET and POSTGRES_PASSWORD problems in the same message', () => {
    // A `.superRefine()` on the loose object would have skipped this check
    // whenever JWT_SECRET also failed to parse — see the doc comment on
    // `validateEnv` for why the production-only checks are collected
    // alongside the schema's rather than run behind an early return.
    let message = '';
    try {
      validateEnv({
        JWT_SECRET: shortSecret,
        NODE_ENV: 'production',
        POSTGRES_PASSWORD: DEFAULT_POSTGRES_PASSWORD,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('JWT_SECRET');
    expect(message).toContain('POSTGRES_PASSWORD');
  });
});
