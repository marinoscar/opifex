import { createTestApp, closeTestApp, TestContext } from '../helpers/test-app.helper';
import { createOpenApiDocument } from '../../src/openapi/document';
import {
  DOCS_PATH,
  OPENAPI_JSON_PATH,
  registerDocsRoutes,
} from '../../src/openapi/register-docs-routes';

/**
 * Exercises the two routes end to end, over the same Fastify instance `main.ts`
 * registers them on.
 *
 * Worth its own suite because these are raw Fastify routes rather than Nest
 * controllers: nothing else in the test surface would notice if the path, the
 * content type, or the registration order broke.
 */
describe('documentation routes', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({
      // Registered before init(), the same point in the boot sequence main.ts
      // uses — Fastify refuses new routes once its root plugin has booted.
      registerRoutes: (app) => registerDocsRoutes(app, createOpenApiDocument(app), '9.9.9'),
    });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  describe(OPENAPI_JSON_PATH, () => {
    it('serves the document as JSON', async () => {
      const response = await context.app.inject({ method: 'GET', url: OPENAPI_JSON_PATH });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');

      const body = response.json();
      expect(body.openapi).toBe('3.1.0');
      expect(body.info.title).toBe('OPIFEX API');
      expect(Object.keys(body.paths).length).toBeGreaterThan(20);
    });
  });

  describe(DOCS_PATH, () => {
    it('serves the reference as HTML', async () => {
      const response = await context.app.inject({ method: 'GET', url: DOCS_PATH });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain(
        '<title>OPIFEX API Reference</title>',
      );
      expect(response.body).toContain('createApiReference');
    });

    it('shows the version it was handed', async () => {
      const response = await context.app.inject({ method: 'GET', url: DOCS_PATH });
      expect(response.body).toContain('9.9.9');
    });

    it('answers on the trailing-slash spelling too', async () => {
      const response = await context.app.inject({ method: 'GET', url: `${DOCS_PATH}/` });
      expect(response.statusCode).toBe(200);
    });

    it('points at the spec rather than inlining it, so the page stays small', async () => {
      const response = await context.app.inject({ method: 'GET', url: DOCS_PATH });

      expect(response.body).toContain(OPENAPI_JSON_PATH);
      // The spec is hundreds of kilobytes; inlining it would be the obvious
      // regression here.
      expect(response.body.length).toBeLessThan(20_000);
    });

    it('reaches the reader without a bearer token — it is how they get one', async () => {
      const response = await context.app.inject({ method: 'GET', url: DOCS_PATH });
      expect(response.statusCode).toBe(200);
    });
  });
});
