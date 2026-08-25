import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';

/**
 * The API with no Google OAuth credentials at all (#138).
 *
 * The rest of `test/auth` runs against `.env.test`, which sets the Google
 * variables, so every other suite exercises the configured path. This one
 * removes them before the app is built — `configuration()` reads `process.env`
 * when the container instantiates it, which is inside `createTestApp` — and
 * asserts the two things #138 asked for: that the app boots at all, and that
 * the Google routes then say something truthful.
 */
describe('OAuth not configured', () => {
  let context: TestContext;

  const GOOGLE_ENV = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_CALLBACK_URL',
  ] as const;
  const originalEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const name of GOOGLE_ENV) {
      originalEnv.set(name, process.env[name]);
      delete process.env[name];
    }

    // Before #138 this line threw `OAuth2Strategy requires a clientID option`
    // and the suite could not reach a single expectation.
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);

    for (const name of GOOGLE_ENV) {
      const original = originalEnv.get(name);
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
  });

  describe('GET /api/auth/providers', () => {
    it('reports no providers instead of being unreachable', async () => {
      // The endpoint whose existence proved providers were meant to be
      // optional, and which the boot failure made impossible to serve.
      const response = await request(context.app.getHttpServer())
        .get('/api/auth/providers')
        .expect(200);

      expect(response.body.data.providers).toEqual([]);
    });
  });

  describe('GET /api/auth/google', () => {
    it('answers 501, not a redirect and not a 500', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/auth/google')
        .expect(501);

      expect(response.body).toMatchObject({
        statusCode: 501,
        code: 'NOT_IMPLEMENTED',
      });
    });

    it('names the variables an operator has to set', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/auth/google')
        .expect(501);

      expect(response.body.message).toContain('GOOGLE_CLIENT_ID');
      expect(response.body.message).toContain('GOOGLE_CLIENT_SECRET');
    });
  });

  describe('GET /api/auth/google/callback', () => {
    it('answers 501 as well, so a stale bookmark gets the same story', async () => {
      // This is the URL a bookmarked or half-finished consent flow returns to.
      // Redirecting it to the frontend with `?error=` would be a worse answer:
      // a deployment with no login has no useful page to send it to.
      const response = await request(context.app.getHttpServer())
        .get('/api/auth/google/callback?code=stale-authorization-code')
        .expect(501);

      expect(response.body.code).toBe('NOT_IMPLEMENTED');
    });
  });

  describe('the rest of the API', () => {
    it('still serves health checks', async () => {
      // #138's actual complaint: everything that does not depend on
      // interactive login should work.
      await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);
    });

    it('still refuses an unauthenticated protected route with 401', async () => {
      // Not 501, and not 500 -- the absence of an OAuth provider must not
      // change how the rest of the authentication chain answers.
      await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .expect(401);
    });
  });
});
