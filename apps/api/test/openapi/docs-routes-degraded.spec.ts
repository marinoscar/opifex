import {
  createTestApp,
  closeTestApp,
  TestContext,
} from '../helpers/test-app.helper';
import { createOpenApiDocument } from '../../src/openapi/document';
import {
  DOCS_PATH,
  DOCS_UNAVAILABLE_MESSAGE,
  DocsLogger,
  OPENAPI_JSON_PATH,
  OPENAPI_UNAVAILABLE_CODE,
  registerDocsRoutesOrDegrade,
} from '../../src/openapi/register-docs-routes';

/**
 * The degraded documentation path (issue #69).
 *
 * `main.ts` builds the OpenAPI document before `app.listen()`, so a throw there
 * used to take the whole process down — issue #60 was exactly that, four DTOs
 * whose zod schema could not be rendered, and no environment could start. The
 * generation failure is now caught and both docs routes serve a 503 instead.
 *
 * This suite exists because that recovery path is, by construction, code that
 * only runs when something is already broken. Untested, it would be discovered
 * for the first time during the incident it is supposed to soften — so it is
 * asserted here as directly as the happy path is.
 */
describe('documentation routes when generation fails', () => {
  const GENERATION_ERROR = new Error(
    'Date cannot be represented in JSON Schema',
  );

  let context: TestContext;
  let logger: DocsLogger & { error: jest.Mock };
  let returned: boolean;

  beforeAll(async () => {
    logger = { error: jest.fn() };

    context = await createTestApp({
      registerRoutes: (app) => {
        returned = registerDocsRoutesOrDegrade(
          app,
          () => {
            throw GENERATION_ERROR;
          },
          logger,
        );
      },
    });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  it('lets the application boot — the whole point of the change', () => {
    // Reaching this line means `createTestApp` resolved: the module compiled,
    // the routes mounted and Fastify became ready despite generation throwing.
    expect(context.app).toBeDefined();
    expect(returned).toBe(false);
  });

  it('serves the rest of the API normally', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/health/live',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('ok');
  });

  it('logs the failure at error level, with the stack', () => {
    expect(logger.error).toHaveBeenCalledTimes(1);

    const [message, stack] = logger.error.mock.calls[0];
    // Names both dead routes so the log line alone explains the symptom an
    // operator is about to see.
    expect(message).toContain(DOCS_PATH);
    expect(message).toContain(OPENAPI_JSON_PATH);
    expect(stack).toBe(GENERATION_ERROR.stack);
    expect(stack).toContain('Date cannot be represented in JSON Schema');
  });

  describe(OPENAPI_JSON_PATH, () => {
    it('answers 503 in the shared error envelope', async () => {
      const response = await context.app.inject({
        method: 'GET',
        url: OPENAPI_JSON_PATH,
      });

      expect(response.statusCode).toBe(503);
      expect(response.headers['content-type']).toContain('application/json');

      const body = response.json();
      expect(body.statusCode).toBe(503);
      expect(body.code).toBe(OPENAPI_UNAVAILABLE_CODE);
      expect(body.message).toBe(DOCS_UNAVAILABLE_MESSAGE);
      expect(body.path).toBe(OPENAPI_JSON_PATH);
      expect(typeof body.timestamp).toBe('string');
    });

    it('says what failed and where to look, not just a status', async () => {
      const response = await context.app.inject({
        method: 'GET',
        url: OPENAPI_JSON_PATH,
      });

      expect(response.json().message).toMatch(/failed to generate/i);
      expect(response.json().message).toMatch(/logs/i);
    });

    it('does not leak the underlying error to an unauthenticated caller', async () => {
      const response = await context.app.inject({
        method: 'GET',
        url: OPENAPI_JSON_PATH,
      });

      expect(response.body).not.toContain('Date cannot be represented');
      // No stack frames: `at <fn> (<file>:<line>:<col>)`.
      expect(response.body).not.toMatch(/\bat .+:\d+:\d+/);
    });
  });

  describe(DOCS_PATH, () => {
    it('answers 503 with a readable page rather than 404', async () => {
      const response = await context.app.inject({
        method: 'GET',
        url: DOCS_PATH,
      });

      expect(response.statusCode).toBe(503);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toMatch(/failed to generate/i);
      expect(response.body).toMatch(/logs/i);
    });

    it('answers on the trailing-slash spelling too', async () => {
      const response = await context.app.inject({
        method: 'GET',
        url: `${DOCS_PATH}/`,
      });

      expect(response.statusCode).toBe(503);
      expect(response.body).toMatch(/failed to generate/i);
    });

    it('renders standalone — it cannot depend on the document that just failed', async () => {
      const response = await context.app.inject({
        method: 'GET',
        url: DOCS_PATH,
      });

      // No Scalar bundle, no fetch of the spec: both would fail for the same
      // reason the document did, leaving a blank page.
      expect(response.body).not.toContain('createApiReference');
      expect(response.body).not.toContain('<script');
      expect(response.body).not.toContain('cdn.jsdelivr.net');
    });

    it('does not leak the underlying error into the page', async () => {
      const response = await context.app.inject({
        method: 'GET',
        url: DOCS_PATH,
      });

      expect(response.body).not.toContain('Date cannot be represented');
    });
  });
});

/**
 * The success path through the same wrapper.
 *
 * `main.ts` no longer calls `registerDocsRoutes` directly, so without this the
 * wrapper could quietly serve 503s — or a subtly different page — in the
 * overwhelmingly common case, and only the failure path would be covered.
 */
describe('documentation routes when generation succeeds', () => {
  let context: TestContext;
  let logger: DocsLogger & { error: jest.Mock };
  let returned: boolean;

  beforeAll(async () => {
    logger = { error: jest.fn() };

    context = await createTestApp({
      registerRoutes: (app) => {
        returned = registerDocsRoutesOrDegrade(
          app,
          () => createOpenApiDocument(app),
          logger,
          '9.9.9',
        );
      },
    });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  it('reports success and logs nothing', () => {
    expect(returned).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('serves the real document, unchanged', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: OPENAPI_JSON_PATH,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');

    const body = response.json();
    expect(body.openapi).toBe('3.1.0');
    expect(body.info.title).toBe('OPIFEX API');
    expect(Object.keys(body.paths).length).toBeGreaterThan(20);
  });

  it('serves the real reference page, unchanged', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: DOCS_PATH,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<title>OPIFEX API Reference</title>');
    expect(response.body).toContain('createApiReference');
    // The version it was handed, proving the argument still reaches the page.
    expect(response.body).toContain('9.9.9');
  });

  it('serves the trailing-slash spelling too', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: `${DOCS_PATH}/`,
    });

    expect(response.statusCode).toBe(200);
  });
});
