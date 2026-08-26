/**
 * Guards the conditional registration of TestAuthModule in AppModule.
 *
 * TestAuthModule exposes POST /api/auth/test/login, which bypasses both OAuth
 * and the email allowlist and can mint an admin session for any email. The
 * registration decision is made at module-evaluation time from process.env, so
 * each case re-imports AppModule with a fresh module registry.
 */
describe('AppModule — TestAuthModule registration', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTestAuth = process.env.TEST_AUTH_ENABLED;
  const originalPostgresPassword = process.env.POSTGRES_PASSWORD;

  beforeEach(() => {
    // Importing AppModule evaluates `ConfigModule.forRoot({ validate })`, and
    // since #299 `validateEnv` refuses a NODE_ENV=production environment whose
    // POSTGRES_PASSWORD is unset or still the shipped default. `.env.test`
    // deliberately sets no POSTGRES_* variables, so the production case below
    // would throw at `require('./app.module')` — before it could report
    // anything about TestAuthModule at all. One is set here for every case, so
    // the only variable that differs between them stays NODE_ENV.
    process.env.POSTGRES_PASSWORD = 'app-module-spec-password';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;

    if (originalTestAuth === undefined) {
      delete process.env.TEST_AUTH_ENABLED;
    } else {
      process.env.TEST_AUTH_ENABLED = originalTestAuth;
    }

    if (originalPostgresPassword === undefined) {
      delete process.env.POSTGRES_PASSWORD;
    } else {
      process.env.POSTGRES_PASSWORD = originalPostgresPassword;
    }
  });

  /**
   * Re-evaluates AppModule under the current env and reports whether
   * TestAuthModule ended up in its imports.
   */
  function importsTestAuthModule(): boolean {
    let registered = false;

    jest.isolateModules(() => {
      const { AppModule } = require('./app.module');

      const { TestAuthModule } = require('./test-auth/test-auth.module');

      const imports: unknown[] =
        Reflect.getMetadata('imports', AppModule) ?? [];
      registered = imports.includes(TestAuthModule);
    });

    return registered;
  }

  it('registers TestAuthModule in development by default', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.TEST_AUTH_ENABLED;

    expect(importsTestAuthModule()).toBe(true);
  });

  it('does not register TestAuthModule when TEST_AUTH_ENABLED is false', () => {
    process.env.NODE_ENV = 'development';
    process.env.TEST_AUTH_ENABLED = 'false';

    expect(importsTestAuthModule()).toBe(false);
  });

  it('does not register TestAuthModule in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.TEST_AUTH_ENABLED;

    expect(importsTestAuthModule()).toBe(false);
  });

  it('still registers TestAuthModule when TEST_AUTH_ENABLED is explicitly true', () => {
    process.env.NODE_ENV = 'development';
    process.env.TEST_AUTH_ENABLED = 'true';

    expect(importsTestAuthModule()).toBe(true);
  });
});

/**
 * AppModule still boots with no database reachable (#161, #352).
 *
 * `test/config/boot-refusal.integration.spec.ts` proves JWT_SECRET and
 * POSTGRES_PASSWORD failures with `{ preview: true }`, which resolves the DI
 * graph WITHOUT instantiating providers or running `onModuleInit` -- exactly
 * the phase this test needs to exercise, so it deliberately does NOT use
 * preview mode here. This is a REAL boot: `PrismaService.onModuleInit()`
 * actually attempts to connect and actually fails (there is no database in
 * this test environment -- the same reason the DB-backed integration specs
 * elsewhere in this suite skip themselves), and `OperatorSettingsService.onModuleInit()`
 * actually calls `refresh()` against that same failed connection.
 *
 * This is the exact boundary #340's migration risked: a managed key's
 * resolver now sits in the boot path of every module that reads one, and
 * `OperatorSettingsService.onModuleInit()` is NOT wrapped in a try/catch by
 * its caller (`app.module.ts`'s module graph) -- the guarantee that a missing
 * database degrades to "resolve from env/default" rather than crashing the
 * process lives entirely inside `refresh()`'s own try/catch. A regression
 * that let a rejection escape THAT specific method -- the same shape of gap
 * this issue's report names in `refresh()`'s current implementation, just on
 * the path where it is actually reachable -- would show up here as a rejected
 * `app.init()`, not as a merely-annoying log line.
 */
describe('AppModule boots with no database reachable (#161, #352)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('resolves app.init() rather than rejecting or hanging', async () => {
    // `.env.test` already sets no POSTGRES_* variables (see the comment in
    // that file), so `PrismaService` falls back to `localhost:5432` -- which
    // this test environment does not have listening, the same fact the
    // DB-backed integration specs elsewhere in this suite skip themselves
    // over. JWT_SECRET is left exactly as `.env.test` supplies it: this test
    // is about the database boundary, not the secret one `boot-refusal...`
    // already covers.
    jest.resetModules();

    // Same three traps `boot-refusal.integration.spec.ts` documents at
    // length: `NestFactory`, `FastifyAdapter` and `AppModule` must all come
    // from the SAME post-reset module registry, or Nest's identity-based DI
    // lookup fails on an unrelated mismatch that has nothing to do with what
    // this test is checking.
    const { NestFactory } =
      require('@nestjs/core') as typeof import('@nestjs/core');
    const { FastifyAdapter } =
      require('@nestjs/platform-fastify') as typeof import('@nestjs/platform-fastify');
    const { AppModule: FreshAppModule } =
      require('./app.module') as typeof import('./app.module');

    const app = await NestFactory.create(FreshAppModule, new FastifyAdapter(), {
      logger: false,
      // NOT preview: this boot must actually run onModuleInit, which is the
      // one thing preview mode skips.
      abortOnError: false,
    });

    // `app.init()` resolving at all is the assertion. `PrismaService`'s own
    // connect attempts (~1.75s of retries, #161) make this slower than most
    // specs; the surrounding timeout is widened accordingly.
    await app.init();

    await app.close();
  }, 30000);
});
