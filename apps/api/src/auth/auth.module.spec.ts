import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthModule } from './auth.module';
import { GoogleStrategy } from './strategies/google.strategy';
import { PrismaService } from '../prisma/prisma.service';
import configuration from '../config/configuration';

/**
 * The regression #138 exists for: the API must boot with no Google OAuth
 * credentials.
 *
 * This compiles the real `AuthModule` — the real provider list, the real
 * factory, the real `passport` registration — rather than asserting on a mock
 * of it. A mock would have happily "constructed" the strategy in both cases,
 * and the bug was entirely in what the real container does at instantiation:
 * `passport-oauth2` throws `OAuth2Strategy requires a clientID option` for the
 * empty string the old provider handed it, before the HTTP server ever
 * started.
 *
 * `compile()` is enough and is deliberately not followed by `init()`: Nest
 * instantiates every provider during `compile()`, which is the exact moment
 * the old code died, while lifecycle hooks (and so any database connection)
 * only run on `init()`.
 */
describe('AuthModule — Google OAuth is optional', () => {
  const GOOGLE_ENV = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_CALLBACK_URL',
  ] as const;

  const originalEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const name of GOOGLE_ENV) originalEnv.set(name, process.env[name]);
  });

  afterEach(() => {
    for (const name of GOOGLE_ENV) {
      const original = originalEnv.get(name);
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
  });

  /**
   * Builds the real AuthModule graph under the current environment.
   *
   * `ignoreEnvFile` so that the `.env` files a developer happens to have on
   * disk cannot put credentials back and turn the unconfigured case green by
   * accident. Prisma is stubbed because this test is about module
   * instantiation, not about the database.
   */
  async function compileAuthModule(): Promise<TestingModule> {
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [configuration],
        }),
        AuthModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
  }

  describe('with no Google credentials', () => {
    let module: TestingModule;

    beforeEach(async () => {
      for (const name of GOOGLE_ENV) delete process.env[name];
      module = await compileAuthModule();
    });

    afterEach(async () => {
      await module?.close();
    });

    it('compiles the module graph without throwing', () => {
      // The assertion is that `beforeEach` got here at all.
      expect(module).toBeDefined();
    });

    it('does not construct the Google strategy', () => {
      // Not "constructs a disabled one": the strategy registers itself with
      // passport as a side effect of construction, so the only way for the
      // route to be genuinely absent is for the object never to exist.
      expect(module.get(GoogleStrategy, { strict: false })).toBeUndefined();
    });
  });

  describe('with Google credentials', () => {
    let module: TestingModule;

    beforeEach(async () => {
      process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com';
      process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
      process.env.GOOGLE_CALLBACK_URL =
        'http://localhost:3535/api/auth/google/callback';
      module = await compileAuthModule();
    });

    afterEach(async () => {
      await module?.close();
    });

    it('constructs the Google strategy exactly as before', () => {
      expect(module.get(GoogleStrategy, { strict: false })).toBeInstanceOf(
        GoogleStrategy,
      );
    });
  });

  describe('with only half the credentials', () => {
    let module: TestingModule;

    afterEach(async () => {
      await module?.close();
    });

    it('still boots, and still does not construct the strategy', async () => {
      // A client id with no secret cannot complete an OAuth exchange, so
      // registering the strategy would only move the failure to a user's
      // login attempt.
      process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com';
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.GOOGLE_CALLBACK_URL;

      module = await compileAuthModule();

      expect(module.get(GoogleStrategy, { strict: false })).toBeUndefined();
    });
  });
});
