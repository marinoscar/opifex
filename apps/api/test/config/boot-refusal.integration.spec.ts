import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Boot-time enforcement of #278: the API must refuse to start at all
 * without a real `JWT_SECRET`.
 *
 * THE TRAP: `ConfigModule.forRoot({ validate })` runs `validateEnv` the
 * moment `app.module.ts` is IMPORTED — it lives inside the `@Module`
 * decorator's metadata literal, in the `imports` array, not inside anything
 * that only runs at `NestFactory.create`. Every other spec in this suite
 * (including `test/auth/oauth-unconfigured.integration.spec.ts`, whose
 * `beforeAll` deletes env vars before calling `createTestApp`) already has
 * `app.module.ts` cached in this file's module registry from `test/setup.ts`
 * dotenv-loading `.env.test`'s real `JWT_SECRET` before any spec code runs.
 * Deleting the variable afterwards and re-importing the *same* cached module
 * would just hand back the already-validated result — the boot check would
 * never re-run, and the test would pass for the wrong reason (or not at
 * all).
 *
 * `jest.resetModules()` forces a genuine re-evaluation: the next `require`
 * of `app.module` re-executes its imports array, including a fresh
 * `ConfigModule.forRoot(...)` call, against whatever `process.env` looks
 * like at that moment.
 *
 * `{ preview: true }` (the same mode `scripts/dump-openapi.ts` uses to boot
 * on a bare checkout) resolves the full module graph — including
 * `ConfigModule.forRoot`'s dynamic-module promise, which is what carries the
 * validation failure. That `dump-openapi.ts` has to pre-seed a `JWT_SECRET`
 * to boot in preview mode at all is confirmation that validation runs there
 * too, not only on a full boot.
 *
 * A SECOND TRAP, found empirically: `NestFactory.create`'s default is
 * `abortOnError: true`, which does not throw or reject on an init failure —
 * it logs and calls `process.exit(1)` directly (`ExceptionsZone`'s default
 * teardown). That is the strongest possible form of "refuses to boot" in
 * production (`main.ts` uses the default deliberately, for exactly that
 * reason), but inside this Jest worker it kills the worker process instead
 * of producing a catchable rejection. `abortOnError: false` below is what
 * makes the failure observable as a normal rejected promise in-process,
 * without weakening what `main.ts` actually does at a real boot.
 *
 * A THIRD TRAP, also found empirically: `NestFactory` and `FastifyAdapter`
 * were originally imported statically at the top of this file, so they came
 * from the registry `test/setup.ts` populated BEFORE `jest.resetModules()`
 * ever ran. Handing a `FreshAppModule` built from a post-reset `@nestjs/core`
 * to the OLD `NestFactory` produced two different copies of the same
 * classes (e.g. `Reflector`) that fail Nest's identity-based DI lookup —
 * surfacing as `Nest can't resolve dependencies of the
 * SchedulerMetadataAccessor (?)`, which has nothing to do with `JWT_SECRET`
 * and everything to do with the mismatched registries. `NestFactory` and
 * `FastifyAdapter` are therefore `require`d fresh, from the same
 * post-reset registry as `AppModule`, inside `bootFresh` below.
 */
async function bootFresh(
  overrides: { abortOnError?: boolean } = {},
): Promise<NestFastifyApplication> {
  // All three requires below MUST come from the same post-resetModules()
  // registry — see the third trap above.
  const { NestFactory } =
    require('@nestjs/core') as typeof import('@nestjs/core');
  const { FastifyAdapter } =
    require('@nestjs/platform-fastify') as typeof import('@nestjs/platform-fastify');
  const { AppModule: FreshAppModule } =
    require('../../src/app.module') as typeof import('../../src/app.module');

  return NestFactory.create<NestFastifyApplication>(
    FreshAppModule,
    new FastifyAdapter(),
    { preview: true, logger: false, abortOnError: false, ...overrides },
  );
}

describe('boot refusal without JWT_SECRET (#278)', () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  afterEach(() => {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
    jest.resetModules();
  });

  it('rejects NestFactory.create when JWT_SECRET is unset', async () => {
    delete process.env.JWT_SECRET;
    jest.resetModules();

    let caught: unknown;
    try {
      const app = await bootFresh();
      // Should be unreachable — close it if it somehow got here, so a
      // failing assertion below doesn't also leak a listener.
      await app.close();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(String(caught)).toContain('JWT_SECRET');
  });

  it('rejects NestFactory.create when JWT_SECRET is set but under the minimum length', async () => {
    process.env.JWT_SECRET = 'too-short';
    jest.resetModules();

    let caught: unknown;
    try {
      const app = await bootFresh();
      await app.close();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(String(caught)).toContain('JWT_SECRET');
  });

  it('boots successfully once JWT_SECRET clears the floor (control)', async () => {
    // Without this, both failures above could just as easily mean
    // "app.module.ts can never boot in this test file for an unrelated
    // reason" and would pass while proving nothing about JWT_SECRET
    // specifically.
    process.env.JWT_SECRET = 'a'.repeat(32);
    jest.resetModules();

    const app = await bootFresh();

    await app.close();
  });
});

/**
 * Boot-time enforcement of #299: the API must refuse to start under
 * `NODE_ENV=production` with a `POSTGRES_PASSWORD` that is unset or still the
 * shipped default. Same three traps as the suite above apply here — see the
 * file-level comment on `bootFresh` — plus one addition: unlike the
 * `JWT_SECRET` cases, these tests also have to flip `NODE_ENV` itself, since
 * `test/setup.ts` forces `NODE_ENV=test` for the whole suite and the rule in
 * `env.validation.ts` only fires under `production`.
 *
 * `.env.test` ships no `POSTGRES_PASSWORD` (see its own comment), so
 * `JWT_SECRET` is already valid here from that file and does not need to be
 * touched by these cases.
 */
describe('boot refusal without a chosen POSTGRES_PASSWORD in production (#299)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPostgresPassword = process.env.POSTGRES_PASSWORD;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalPostgresPassword === undefined) {
      delete process.env.POSTGRES_PASSWORD;
    } else {
      process.env.POSTGRES_PASSWORD = originalPostgresPassword;
    }

    jest.resetModules();
  });

  it('rejects NestFactory.create when NODE_ENV=production and POSTGRES_PASSWORD is unset', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.POSTGRES_PASSWORD;
    jest.resetModules();

    let caught: unknown;
    try {
      const app = await bootFresh();
      // Should be unreachable — close it if it somehow got here, so a
      // failing assertion below doesn't also leak a listener.
      await app.close();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(String(caught)).toContain('POSTGRES_PASSWORD');
  });

  it('rejects NestFactory.create when NODE_ENV=production and POSTGRES_PASSWORD is the shipped default', async () => {
    process.env.NODE_ENV = 'production';
    process.env.POSTGRES_PASSWORD = 'postgres';
    jest.resetModules();

    let caught: unknown;
    try {
      const app = await bootFresh();
      await app.close();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(String(caught)).toContain('POSTGRES_PASSWORD');
  });

  it('boots successfully once POSTGRES_PASSWORD is a real value in production (control)', async () => {
    // Without this, both failures above could just as easily mean
    // "app.module.ts can never boot under NODE_ENV=production in this test
    // file for an unrelated reason" and would pass while proving nothing
    // about POSTGRES_PASSWORD specifically.
    process.env.NODE_ENV = 'production';
    process.env.POSTGRES_PASSWORD = 'a-real-password-nobody-guessed';
    jest.resetModules();

    const app = await bootFresh();

    await app.close();
  });
});
