import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { OpenAPIObject } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { renderDocsPage, renderDocsUnavailablePage } from './docs-page';
import { resolveApiVersion } from './version';

/** Canonical machine-readable document. */
export const OPENAPI_JSON_PATH = '/api/openapi.json';
/** Interactive reference. */
export const DOCS_PATH = '/api/docs';

/**
 * Machine-readable code on the degraded JSON response.
 *
 * Not one of `HttpExceptionFilter`'s status-derived codes: these are raw
 * Fastify routes that never reach the filter, and the code it would produce for
 * a 503 is the `ERROR` fallback, which tells a client nothing. A distinct code
 * lets a consumer distinguish "the spec is temporarily ungenerated" from any
 * other 503 the deployment can emit.
 */
export const OPENAPI_UNAVAILABLE_CODE = 'OPENAPI_DOCUMENT_UNAVAILABLE';

/** Shown on the degraded page and returned as the degraded JSON `message`. */
export const DOCS_UNAVAILABLE_MESSAGE =
  'The API reference failed to generate when this server started. ' +
  'Check the server logs for the underlying error.';

/**
 * The subset of `Logger` this module needs, so a spec can pass a spy without
 * constructing (or silencing) a real Nest logger.
 */
export interface DocsLogger {
  error(message: string, stack?: string): void;
}

type DocsRouteHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => unknown;

interface DocsHandlers {
  /** Serves `OPENAPI_JSON_PATH`. */
  json: DocsRouteHandler;
  /** Serves `DOCS_PATH` and its trailing-slash spelling. */
  page: DocsRouteHandler;
}

/**
 * Registers the two documentation routes on the Fastify instance.
 *
 * Raw Fastify routes rather than `SwaggerModule.setup`, for two reasons: the
 * page is our own template (see `docs-page.ts` for why), and `setup` would
 * additionally mount the stock Swagger UI on the same path.
 *
 * Registering directly also keeps both routes outside the Nest guard pipeline —
 * matching what `SwaggerModule.setup` already did, and keeping the reference
 * readable during maintenance mode, which is exactly when an operator is most
 * likely to want it.
 *
 * Lives here rather than inline in `main.ts` so it can be exercised against a
 * test application; `main.ts` itself is excluded from coverage and cannot be
 * booted by a spec.
 *
 * Throws whatever `renderDocsPage` throws. `main.ts` calls
 * {@link registerDocsRoutesOrDegrade} instead, which is this plus the failure
 * handling; call this one directly only where a throw is what you want.
 */
export function registerDocsRoutes(
  app: NestFastifyApplication,
  document: OpenAPIObject,
  version: string = resolveApiVersion(),
): void {
  mountDocsRoutes(app, buildDocsHandlers(document, version));
}

/**
 * Builds the document and registers the routes, degrading to a 503 on both
 * paths if either step throws.
 *
 * WHY THIS IS WRAPPED AT ALL (issue #69)
 * ---------------------------------------------------------------------------
 * `main.ts` builds the document before `app.listen()`. Generation walks every
 * controller's metadata and every DTO's schema, which is the largest failure
 * surface of anything that runs before the port is bound — so an unguarded
 * throw turns a documentation defect into a total outage. That is not
 * hypothetical: issue #60 was four DTOs using `z.date()`, which zod v4 refuses
 * to represent in JSON Schema, and the API could not start in any environment
 * because of it. The reference is a convenience; the API is not. Their
 * availability should not be coupled.
 *
 * WHY THERE IS NO `NODE_ENV` GATE
 * ---------------------------------------------------------------------------
 * The obvious alternative is to rethrow outside production, on the theory that
 * a developer wants a loud crash. We deliberately do not, for two reasons.
 *
 * First, it would make the recovery path production-only — a path that runs
 * exclusively in the environment nobody can rehearse in, discovered for the
 * first time during the incident it exists to soften. Degrading everywhere
 * means every `npm test` run, every local boot and every CI job exercises the
 * same code production depends on.
 *
 * Second, the loud signal a developer needs already exists and is stronger than
 * a crash: the `openapi` CI job runs `openapi:dump`, which calls
 * `createOpenApiDocument` outside any try/catch and exits non-zero on failure,
 * so a broken document still fails the build and cannot merge. Add the
 * `error`-level log below and the 503 that replaces the page, and a local
 * failure is impossible to miss without also being impossible to work around.
 * Degrading here narrows the blast radius; it does not make a broken document
 * acceptable.
 *
 * @returns `true` if the real reference was registered, `false` if the degraded
 *   one was — so the caller can log accordingly.
 */
export function registerDocsRoutesOrDegrade(
  app: NestFastifyApplication,
  buildDocument: () => OpenAPIObject,
  logger: DocsLogger = new Logger('OpenAPI'),
  version: string = resolveApiVersion(),
): boolean {
  let handlers: DocsHandlers;
  let ok = true;

  // Everything fallible happens here, BEFORE the first `fastify.get`. If a
  // route were already mounted when the failure surfaced, mounting the
  // replacement would collide with it and throw a second time — out of the
  // catch, and back into the outage this function exists to prevent.
  try {
    handlers = buildDocsHandlers(buildDocument(), version);
  } catch (error) {
    ok = false;
    logger.error(
      `OpenAPI document generation failed; ${DOCS_PATH} and ${OPENAPI_JSON_PATH} ` +
        'will return 503. The rest of the API is unaffected.',
      error instanceof Error ? error.stack : String(error),
    );
    handlers = buildDegradedDocsHandlers();
  }

  mountDocsRoutes(app, handlers);
  return ok;
}

/** Handlers for a document that built successfully. */
function buildDocsHandlers(
  document: OpenAPIObject,
  version: string,
): DocsHandlers {
  const page = renderDocsPage({
    title: 'OPIFEX API Reference',
    version,
    specUrl: OPENAPI_JSON_PATH,
  });

  return {
    json: (_req, reply) => reply.type('application/json').send(document),
    page: (_req, reply) => reply.type('text/html').send(page),
  };
}

/**
 * Handlers for a document that did not build.
 *
 * 503 rather than 404 or a bare status: a 404 would read as "this deployment
 * has no reference", which is wrong and sends the reader looking in the wrong
 * place. 503 says the resource exists and is currently unavailable, and both
 * bodies say why and where to look. Neither carries the error itself — that is
 * in the log, and these routes are unauthenticated.
 */
function buildDegradedDocsHandlers(): DocsHandlers {
  const page = renderDocsUnavailablePage({
    message: DOCS_UNAVAILABLE_MESSAGE,
    specUrl: OPENAPI_JSON_PATH,
  });

  return {
    json: (request, reply) =>
      reply
        .code(503)
        .type('application/json')
        // The shared error envelope, hand-built: `HttpExceptionFilter` shapes
        // this for Nest routes, and these are not Nest routes.
        .send({
          statusCode: 503,
          code: OPENAPI_UNAVAILABLE_CODE,
          message: DOCS_UNAVAILABLE_MESSAGE,
          timestamp: new Date().toISOString(),
          path: request.url,
        }),
    page: (_req, reply) => reply.code(503).type('text/html').send(page),
  };
}

/** The route table itself — identical whether the document built or not. */
function mountDocsRoutes(
  app: NestFastifyApplication,
  handlers: DocsHandlers,
): void {
  const fastify = app.getHttpAdapter().getInstance();

  fastify.get(OPENAPI_JSON_PATH, handlers.json);

  // Both spellings: a reader who types the path with a trailing slash should
  // not get a 404 from the one page whose job is to orient them.
  for (const path of [DOCS_PATH, `${DOCS_PATH}/`]) {
    fastify.get(path, handlers.page);
  }
}
