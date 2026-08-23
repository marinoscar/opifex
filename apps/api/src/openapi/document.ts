// =============================================================================
// OpenAPI document construction (issue #53)
// =============================================================================
//
// Everything that shapes `/api/openapi.json` lives here rather than in
// `main.ts`, for one concrete reason: the spec is now asserted by tests and
// dumped by a CI script, and neither of those can boot a listening server. A
// pure `buildOpenApiConfig()` / `createOpenApiDocument(app)` pair can be called
// from a test harness, from `scripts/dump-openapi.ts`, and from `main.ts`
// alike, so the document CI lints is the document users get.
// =============================================================================

import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { ErrorDto } from '../common/dto/error.dto';
import { RBAC_EXTENSION_KEY } from '../auth/decorators/auth.decorator';
import { applyDataEnvelope } from './data-envelope';
import { buildApiDescription } from './description';
import { applyNullableFor31 } from './nullable';
import { applyRbacDocs } from './rbac-docs';
import { OPENAPI_TAGS, OPENAPI_TAG_GROUPS } from './tags';
import { DocOperation, MutableDocument, forEachOperation } from './types';
import { resolveApiVersion } from './version';

/**
 * Security scheme names. `JWT_AUTH` is referenced by name from `@Auth()`.
 *
 * Exactly two, because exactly two credentials exist: a session access token
 * and a personal access token. There is no third, narrower credential to
 * declare, and inventing a scheme for one would document an authentication this
 * server cannot perform.
 */
export const SECURITY_SCHEMES = {
  JWT_AUTH: 'JWT-auth',
  PAT_AUTH: 'PAT-auth',
} as const;

/**
 * The `DocumentBuilder` configuration.
 *
 * @param version resolved application version; injectable so a test can assert
 *   the shape without depending on what the build happens to be stamped with.
 */
export function buildOpenApiConfig(version: string = resolveApiVersion()) {
  const builder = new DocumentBuilder()
    .setTitle('OPIFEX API')
    .setDescription(buildApiDescription(version))
    .setVersion(version)
    // OpenAPI 3.1, not the 3.0 default. This is required, not a preference:
    // zod v4 emits JSON Schema 2020-12, which 3.1 adopts wholesale and 3.0
    // rejects — under 3.0 the zod-derived DTOs publish numeric
    // `exclusiveMinimum` and `propertyNames` keywords that are invalid there,
    // so a schema-validating consumer (and Spectral) rightly fails on them.
    // Scalar renders 3.1 natively.
    .setOpenAPIVersion('3.1.0')
    .setContact('OPIFEX', 'https://github.com/marinoscar/opifex', '')
    .setExternalDoc(
      'Architecture and operations documentation',
      'https://github.com/marinoscar/opifex/tree/main/docs',
    )
    // Same-origin: the UI is served at `/`, this API under `/api`, so a
    // relative server URL is correct for every deployment without templating.
    .addServer('/', 'This deployment (same-origin)')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Short-lived session access token from `POST /api/auth/refresh` or the OAuth callback. ' +
          'On this page, use "Authorize with my session" to load one automatically.',
      },
      SECURITY_SCHEMES.JWT_AUTH,
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description:
          'Personal access token (`pat_…`) from `POST /api/pat`. Long-lived, carries the full ' +
          'permission set of the user that minted it, and is accepted on every authenticated route.',
      },
      SECURITY_SCHEMES.PAT_AUTH,
    );

  for (const tag of OPENAPI_TAGS) {
    builder.addTag(tag.name, tag.description);
  }

  const config = builder.build();

  // `setContact` takes all three fields positionally, so an omitted email is an
  // empty string — which is not a valid `email`, and a schema-validating
  // consumer rejects the whole document over it. A contact with a name and a URL
  // is perfectly valid; fabricating an address to satisfy the field would be
  // worse than not having one.
  if (config.info.contact && !config.info.contact.email) {
    delete (config.info.contact as { email?: string }).email;
  }

  return config;
}

/**
 * Builds the finished document: Nest's introspection, then the passes that turn
 * it into something worth reading.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(app, buildOpenApiConfig(), {
    // Namespaced but readable: `users_listUsers`, not `UsersController_listUsers`.
    // Stable across refactors that do not rename the controller or handler, which
    // is what makes generated SDK method names survive a release.
    operationIdFactory: buildOperationId,
    // ErrorDto is only ever referenced from a `$ref` this file writes, so it
    // would otherwise never be emitted into `components.schemas`.
    extraModels: [ErrorDto],
  });

  // nestjs-zod's recommended post-processing for zod-derived DTOs. Without it
  // every `createZodDto` class publishes an empty `{}` schema — which is what
  // the scaffold's `main.ts` did, and the single largest defect this module
  // exists to fix.
  const cleaned = cleanupOpenApiDoc(document);

  // `OpenAPIObject` has no index signature, so it is not structurally a
  // `MutableDocument` even though every field the passes touch is present.
  // Widening here is the one place that conversion happens.
  enrichOpenApiDocument(cleaned as unknown as MutableDocument);

  return cleaned;
}

/**
 * The post-processing passes, split out from `createOpenApiDocument` so they can
 * be exercised against a hand-built document without booting an application.
 */
export function enrichOpenApiDocument<T extends MutableDocument>(
  document: T,
): T {
  applyRbacDocs(document);
  applyAlternativeAuthSchemes(document);
  // Order matters: the envelope pass targets 2xx JSON responses only, and the
  // error pass writes a `default` response — running the envelope first keeps
  // the two from ever meeting, but relying on that would be fragile, so the
  // envelope pass filters on the status code explicitly as well.
  applyDataEnvelope(document);
  applyDefaultErrorResponse(document);
  applyTagGroups(document);
  // LAST, and it must stay last: every earlier pass may introduce schemas of
  // its own, and this one has to see all of them. A `nullable` that slips
  // through is not ignored by a 3.1 consumer — it reads `type: "string"` and
  // generates a non-nullable field.
  applyNullableFor31(document);
  return document;
}

/**
 * `UsersController.listUsers` → `users_listUsers`.
 *
 * Keeps the controller as a namespace (so two `list` handlers cannot collide)
 * while dropping the noise a generator would otherwise bake into every method
 * name. Uniqueness is asserted in `test/openapi/openapi-document.spec.ts`.
 */
export function buildOperationId(
  controllerKey: string,
  methodKey: string,
): string {
  const namespace = controllerKey.replace(/Controller$/, '');
  const lowerFirst = namespace.charAt(0).toLowerCase() + namespace.slice(1);
  return `${lowerFirst}_${methodKey}`;
}

/**
 * Whether an operation requires a bearer token.
 *
 * Two signals, because two things put one there. `@Auth()` stamps `x-rbac`,
 * which is the richer marker. A handful of routes instead compose
 * `@UseGuards(JwtAuthGuard)` with a bare `@ApiBearerAuth('JWT-auth')` — on the
 * auth controller, where the RBAC guards would have nothing to check, and on
 * the device-authorization controller — and those are just as authenticated.
 */
export function isAuthenticatedOperation(operation: DocOperation): boolean {
  if (operation[RBAC_EXTENSION_KEY] !== undefined) return true;
  return (operation.security ?? []).some(
    (entry) => SECURITY_SCHEMES.JWT_AUTH in entry,
  );
}

/**
 * Adds the PAT scheme to every operation it actually works on.
 *
 * `@Auth()` can only declare the session scheme, because that is the one it
 * names. But a PAT authenticates every authenticated route, and that is a fact
 * a reader needs.
 *
 * The claim is universal because the mechanism is: `JwtAuthGuard.canActivate`
 * intercepts any `Authorization: Bearer pat_…` header and resolves it through
 * `PatService.validateToken` BEFORE delegating to the JWT passport strategy,
 * setting the same `AuthenticatedUser` shape on the request that the strategy
 * would. `RolesGuard` and `PermissionsGuard` therefore see identical input
 * either way. Since every authenticated route in this API is guarded by
 * `JwtAuthGuard` — via `@Auth()` or a direct `@UseGuards(JwtAuthGuard)` — there
 * is no authenticated route a PAT is rejected on.
 *
 * Deriving it here from the `x-rbac` marker and the declared security keeps the
 * claim accurate as routes are added, where a hand-applied `@ApiSecurity()`
 * would quietly go stale. If a future route ever authenticates through some
 * other guard, `isAuthenticatedOperation` will not match it and it will not be
 * given a claim this pass cannot back up.
 *
 * Multiple entries in an operation's `security` array are alternatives (OR), so
 * appending never tightens a requirement.
 */
function applyAlternativeAuthSchemes(document: MutableDocument): void {
  forEachOperation(document, (operation) => {
    if (!isAuthenticatedOperation(operation)) return;

    const security = (operation.security ??= []);
    const has = (name: string) => security.some((entry) => name in entry);

    if (!has(SECURITY_SCHEMES.PAT_AUTH)) {
      security.push({ [SECURITY_SCHEMES.PAT_AUTH]: [] });
    }
  });
}

/**
 * Attaches the shared error envelope as each operation's `default` response.
 *
 * A `default` rather than an enumerated 400/404/409 list per operation: every
 * error from every route passes through one `HttpExceptionFilter` and comes
 * back in one shape, so `default` states exactly that — without asserting on
 * each route's behalf which statuses it can produce, which nobody could keep
 * true as controllers change.
 *
 * Operations that document a specific status keep it; this only fills the gap.
 */
function applyDefaultErrorResponse(document: MutableDocument): void {
  forEachOperation(document, (operation) => {
    const responses = (operation.responses ??= {});
    if (responses.default) return;

    responses.default = {
      description:
        'Error. Every failure is rendered by the shared exception filter into this envelope; ' +
        'endpoint-specific data appears under `details`.',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorDto' },
        },
      },
    };
  });
}

/**
 * Emits `x-tagGroups`, the vendor extension Scalar and Redoc read to render a
 * sectioned sidebar. Renderers without support fall back to the flat `tags`
 * array, which `buildOpenApiConfig` emits in the same order.
 *
 * Tags no operation uses are pruned from both. The taxonomy is declared for the
 * whole application, but not every module is registered in every environment —
 * `app.module.ts` registers `TestAuthModule` only when
 * `NODE_ENV !== 'production'` — and a declared-but-unused tag renders as an
 * empty sidebar section. Pruning is what makes one static taxonomy correct in
 * both environments.
 */
function applyTagGroups(document: MutableDocument): void {
  const used = new Set<string>();
  forEachOperation(document, (operation) => {
    for (const tag of operation.tags ?? []) used.add(tag);
  });

  document.tags = OPENAPI_TAGS.filter((tag) => used.has(tag.name));
  document['x-tagGroups'] = OPENAPI_TAG_GROUPS.map((group) => ({
    name: group.name,
    tags: group.tags.filter((tag) => used.has(tag)),
  })).filter((group) => group.tags.length > 0);
}
