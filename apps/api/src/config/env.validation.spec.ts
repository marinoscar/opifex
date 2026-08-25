import { validateEnv, SECRET_MIN_LENGTH } from './env.validation';

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
    });

    expect(result.INITIAL_ADMIN_EMAIL).toBe('admin@example.com');
    expect(result.NODE_ENV).toBe('production');
  });
});
