import { createTestApp, closeTestApp, TestContext } from '../helpers/test-app.helper';
import {
  createOpenApiDocument,
  isAuthenticatedOperation,
  SECURITY_SCHEMES,
} from '../../src/openapi/document';
import { OPENAPI_TAGS, OPENAPI_TAG_GROUPS } from '../../src/openapi/tags';
import { REQUIREMENTS_MARKER } from '../../src/openapi/rbac-docs';
import { RBAC_EXTENSION_KEY } from '../../src/auth/decorators/auth.decorator';
import { DocOperation, forEachOperation, MutableDocument } from '../../src/openapi/types';

/**
 * Boots the real AppModule once and asserts the document it produces.
 *
 * These are the guardrails: a spec that can silently rot is the failure mode
 * this whole feature exists to remove, so every claim the docs page makes about
 * itself (no orphan tags, generated RBAC lines, an error envelope everywhere,
 * every declared security scheme actually defined) is checked here rather than
 * by a reviewer noticing.
 */
describe('OpenAPI document', () => {
  let context: TestContext;
  let document: MutableDocument;
  let operations: Array<{ path: string; method: string; operation: DocOperation }>;

  beforeAll(async () => {
    context = await createTestApp();
    document = createOpenApiDocument(context.app) as unknown as MutableDocument;

    operations = [];
    forEachOperation(document, (operation, path, method) => {
      operations.push({ path, method, operation });
    });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  it('produces a non-trivial document', () => {
    expect(operations.length).toBeGreaterThan(30);
  });

  describe('branding and metadata', () => {
    it('is titled after this product', () => {
      const info = document.info as { title: string; version: string; description: string };
      expect(info.title).toBe('OPIFEX API');
      expect(info.description).toContain('OPIFEX');
    });

    it('reports a real version rather than the hardcoded 1.0', () => {
      const { version } = document.info as { version: string };
      expect(version).not.toBe('1.0');
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('declares a same-origin server so the built-in client targets this deployment', () => {
      expect(document.servers).toEqual([expect.objectContaining({ url: '/' })]);
    });

    it('publishes OpenAPI 3.1, which zod v4 schemas require', () => {
      // Not cosmetic: zod v4 emits JSON Schema 2020-12, whose numeric
      // `exclusiveMinimum` and `propertyNames` forms are invalid under 3.0.
      expect(document.openapi).toBe('3.1.0');
    });

    it('carries no 3.0-only `nullable` keyword, which a 3.1 consumer would ignore', () => {
      // Ignoring it means generating a non-nullable field — wrong about exactly
      // the values most likely to break a client.
      expect(JSON.stringify(document)).not.toContain('"nullable"');
    });

    it('publishes no empty object schema — the cleanupOpenApiDoc proof', () => {
      // Every `createZodDto` class publishes a placeholder `{}` until
      // nestjs-zod's `cleanupOpenApiDoc` resolves it. An object schema with no
      // properties and no `additionalProperties` is that placeholder surviving,
      // which is precisely the defect this module was written to fix.
      const schemas = (document.components as { schemas: Record<string, Record<string, unknown>> })
        .schemas;
      const empty = Object.entries(schemas)
        .filter(
          ([, schema]) =>
            schema.type === 'object' &&
            schema.properties === undefined &&
            schema.additionalProperties === undefined &&
            schema.allOf === undefined &&
            schema.oneOf === undefined &&
            schema.anyOf === undefined,
        )
        .map(([name]) => name);
      expect(empty).toEqual([]);
    });

    it('omits the contact email rather than publishing an invalid empty one', () => {
      const contact = (document.info as { contact?: Record<string, unknown> }).contact;
      expect(contact).toBeDefined();
      expect(contact).not.toHaveProperty('email');
    });

    it('documents the getting-started essentials in the description', () => {
      const { description } = document.info as { description: string };
      // Each of these is a question a first-time caller has to answer before
      // they can make a single successful request.
      expect(description).toContain('pat_');
      expect(description).toContain('RFC 8628');
      expect(description).toContain('totalItems');
      expect(description).toContain('resource:action');
    });

    it('describes both list shapes, because a client will meet both', () => {
      const { description } = document.info as { description: string };
      expect(description).toContain('/api/users');
      expect(description).toContain('/api/storage/objects');
    });
  });

  describe('tag taxonomy', () => {
    const usedTags = (): Set<string> => {
      const tags = new Set<string>();
      for (const { operation } of operations) {
        for (const tag of operation.tags ?? []) tags.add(tag);
      }
      return tags;
    };

    it('declares every tag an operation actually uses', () => {
      const declared = new Set(OPENAPI_TAGS.map((tag) => tag.name));
      const undeclared = [...usedTags()].filter((tag) => !declared.has(tag));
      expect(undeclared).toEqual([]);
    });

    it('has no declared tag that no operation uses', () => {
      // Asserted against the PUBLISHED tags rather than the declaration, because
      // `applyTagGroups` prunes: `Test Authentication` is declared but its module
      // is registered only outside production, and this suite runs with it on.
      const used = usedTags();
      const published = (document.tags as Array<{ name: string }>).map((tag) => tag.name);
      expect(published.filter((tag) => !used.has(tag))).toEqual([]);
    });

    it('prunes rather than publishes a tag whose module is not registered here', () => {
      // The declaration is a superset of what any one environment uses; pruning
      // is what makes one static taxonomy correct in both.
      const published = new Set((document.tags as Array<{ name: string }>).map((t) => t.name));
      const declared = OPENAPI_TAGS.map((t) => t.name);
      expect(declared.every((tag) => usedTags().has(tag) === published.has(tag))).toBe(true);
    });

    it('gives every declared tag a description', () => {
      const undescribed = (document.tags as Array<{ name: string; description?: string }>)
        .filter((tag) => !tag.description)
        .map((tag) => tag.name);
      expect(undescribed).toEqual([]);
    });

    it('places every tag in exactly one x-tagGroup', () => {
      const grouped = OPENAPI_TAG_GROUPS.flatMap((group) => group.tags);
      expect(new Set(grouped).size).toBe(grouped.length);
      expect(new Set(grouped)).toEqual(new Set(OPENAPI_TAGS.map((tag) => tag.name)));
    });

    it('publishes x-tagGroups covering exactly the published tags', () => {
      const groups = document['x-tagGroups'] as Array<{ name: string; tags: string[] }>;
      const published = (document.tags as Array<{ name: string }>).map((tag) => tag.name);
      expect(groups.flatMap((group) => group.tags).sort()).toEqual([...published].sort());
      expect(groups.map((group) => group.name)).toEqual(
        OPENAPI_TAG_GROUPS.filter((group) =>
          group.tags.some((tag) => published.includes(tag)),
        ).map((group) => group.name),
      );
    });
  });

  describe('operation ids', () => {
    it('gives every operation a namespaced id', () => {
      const missing = operations
        .filter(({ operation }) => !operation.operationId)
        .map(({ path, method }) => `${method} ${path}`);
      expect(missing).toEqual([]);
    });

    it('keeps operation ids unique, so a generated SDK has no colliding methods', () => {
      const seen = new Map<string, string>();
      const collisions: string[] = [];
      for (const { path, method, operation } of operations) {
        const id = operation.operationId as string;
        const previous = seen.get(id);
        if (previous) collisions.push(`${id}: ${previous} and ${method} ${path}`);
        else seen.set(id, `${method} ${path}`);
      }
      expect(collisions).toEqual([]);
    });

    it('drops the "Controller" noise a generator would otherwise bake into names', () => {
      const ids = operations.map(({ operation }) => operation.operationId as string);
      expect(ids.some((id) => /Controller_/.test(id))).toBe(false);
      expect(ids).toContain('users_listUsers');
    });
  });

  describe('self-documenting RBAC', () => {
    const guarded = () =>
      operations.filter(({ operation }) => operation[RBAC_EXTENSION_KEY] !== undefined);
    const authenticated = () =>
      operations.filter(({ operation }) => isAuthenticatedOperation(operation));

    it('guards a substantial share of the surface', () => {
      expect(guarded().length).toBeGreaterThan(10);
    });

    it('states the requirements of every guarded operation in its description', () => {
      const silent = guarded()
        .filter(({ operation }) => !(operation.description ?? '').includes(REQUIREMENTS_MARKER))
        .map(({ path, method }) => `${method} ${path}`);
      expect(silent).toEqual([]);
    });

    it('names the actual permission a guarded operation requires', () => {
      const usersList = operations.find(
        ({ path, method }) => path === '/api/users' && method === 'get',
      );
      expect(usersList?.operation.description).toContain('`users:read`');
    });

    it('appends to the hand-written description rather than replacing it', () => {
      const withProse = guarded().find(
        ({ operation }) =>
          (operation.description ?? '').split(REQUIREMENTS_MARKER)[0].trim().length > 0,
      );
      expect(withProse).toBeDefined();
    });

    it('states requirements on routes guarded by JwtAuthGuard alone too', () => {
      // The auth and device-authorization controllers compose
      // `@UseGuards(JwtAuthGuard)` with a bare `@ApiBearerAuth('JWT-auth')`
      // rather than `@Auth()`; they are still authenticated and must still say so.
      const silent = authenticated()
        .filter(({ operation }) => !(operation.description ?? '').includes(REQUIREMENTS_MARKER))
        .map(({ path, method }) => `${method} ${path}`);
      expect(silent).toEqual([]);
    });

    it('leaves public operations alone', () => {
      const live = operations.find(
        ({ path, method }) => path === '/api/health/live' && method === 'get',
      );
      expect(live?.operation.description ?? '').not.toContain(REQUIREMENTS_MARKER);
    });
  });

  describe('authentication schemes', () => {
    it('documents both bearer credentials, and only those two', () => {
      const schemes = (document.components as { securitySchemes: Record<string, unknown> })
        .securitySchemes;
      expect(Object.keys(schemes).sort()).toEqual(
        [SECURITY_SCHEMES.JWT_AUTH, SECURITY_SCHEMES.PAT_AUTH].sort(),
      );
    });

    it('names a declared scheme in every security requirement', () => {
      // The scaffold's three bare `@ApiBearerAuth()` calls emitted
      // `security: [{ bearer: [] }]` against a scheme the document never
      // defined, so the Authorize dialog had nothing to attach and an
      // authorized reader still got 401 from all three. This is the proof
      // that cannot happen again.
      const declared = new Set(
        Object.keys(
          (document.components as { securitySchemes: Record<string, unknown> }).securitySchemes,
        ),
      );
      const undeclared: string[] = [];
      for (const { path, method, operation } of operations) {
        for (const entry of operation.security ?? []) {
          for (const name of Object.keys(entry)) {
            if (!declared.has(name)) undeclared.push(`${method} ${path}: ${name}`);
          }
        }
      }
      expect(undeclared).toEqual([]);
    });

    it('offers session and PAT auth as alternatives on every authenticated operation', () => {
      // A PAT really is universal: `JwtAuthGuard.canActivate` resolves any
      // `Bearer pat_…` header before delegating to the JWT strategy, and every
      // authenticated route in this API is guarded by `JwtAuthGuard`.
      const missing = operations
        .filter(({ operation }) => isAuthenticatedOperation(operation))
        .filter(({ operation }) => {
          const names = (operation.security ?? []).flatMap((entry) => Object.keys(entry));
          return (
            !names.includes(SECURITY_SCHEMES.JWT_AUTH) ||
            !names.includes(SECURITY_SCHEMES.PAT_AUTH)
          );
        })
        .map(({ path, method }) => `${method} ${path}`);
      expect(missing).toEqual([]);
    });

    it('claims no credential on an operation that requires none', () => {
      const overreach = operations
        .filter(({ operation }) => !isAuthenticatedOperation(operation))
        .filter(({ operation }) => (operation.security ?? []).length > 0)
        .map(({ path, method }) => `${method} ${path}`);
      expect(overreach).toEqual([]);
    });
  });

  describe('error envelope', () => {
    it('publishes the shared ErrorDto schema', () => {
      const schemas = (document.components as { schemas: Record<string, unknown> }).schemas;
      expect(schemas.ErrorDto).toBeDefined();
    });

    it('publishes exactly the six keys the exception filter can emit', () => {
      const errorDto = (
        document.components as { schemas: Record<string, { properties: Record<string, unknown> }> }
      ).schemas.ErrorDto;
      expect(Object.keys(errorDto.properties).sort()).toEqual(
        ['code', 'details', 'message', 'path', 'statusCode', 'timestamp'].sort(),
      );
    });

    it('documents the envelope as the default response on every operation', () => {
      const missing = operations
        .filter(({ operation }) => {
          const fallback = operation.responses?.default as
            | { content?: Record<string, { schema?: { $ref?: string } }> }
            | undefined;
          return (
            fallback?.content?.['application/json']?.schema?.$ref !==
            '#/components/schemas/ErrorDto'
          );
        })
        .map(({ path, method }) => `${method} ${path}`);
      expect(missing).toEqual([]);
    });

    it('documents 401 and 403 on operations guarded by @Auth()', () => {
      const missing = operations
        .filter(({ operation }) => operation[RBAC_EXTENSION_KEY] !== undefined)
        .filter(({ operation }) => !operation.responses?.['401'] || !operation.responses?.['403'])
        .map(({ path, method }) => `${method} ${path}`);
      expect(missing).toEqual([]);
    });

    it('leaves error responses unwrapped, because the filter bypasses the interceptor', () => {
      const fallback = operations[0].operation.responses?.default as {
        content: Record<string, { schema: Record<string, unknown> }>;
      };
      expect(fallback.content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/ErrorDto',
      });
    });
  });

  describe('response envelope accuracy', () => {
    const jsonSchema = (path: string, method: string, status: string) => {
      const found = operations.find((op) => op.path === path && op.method === method);
      return (
        found?.operation.responses?.[status] as {
          content?: Record<string, { schema?: Record<string, unknown> }>;
        }
      )?.content?.['application/json']?.schema;
    };

    it('wraps a plain DTO response in the { data } envelope the interceptor produces', () => {
      const schema = jsonSchema('/api/user-settings', 'get', '200');
      expect(schema?.properties).toHaveProperty('data');
      expect(schema?.properties).toHaveProperty('meta');
    });

    it('does not double-wrap a handler that already returns { data }', () => {
      const schema = jsonSchema('/api/auth/me', 'get', '200') as {
        properties: { data: Record<string, unknown> };
      };
      expect(schema.properties.data).not.toHaveProperty('properties.data');
    });

    it('documents the flat list shape for /api/users', () => {
      const schema = jsonSchema('/api/users', 'get', '200') as {
        properties: { data: { properties: Record<string, unknown> } };
      };
      expect(Object.keys(schema.properties.data.properties).sort()).toEqual(
        ['items', 'page', 'pageSize', 'total', 'totalPages'].sort(),
      );
    });

    it('documents the nested list shape for /api/storage/objects', () => {
      // Different from /api/users on purpose: this is what the service returns.
      const schema = jsonSchema('/api/storage/objects', 'get', '200') as {
        properties: { data: { properties: Record<string, { properties?: object }> } };
      };
      expect(Object.keys(schema.properties.data.properties).sort()).toEqual(['items', 'meta']);
      expect(Object.keys(schema.properties.data.properties.meta.properties ?? {}).sort()).toEqual(
        ['page', 'pageSize', 'totalItems', 'totalPages'].sort(),
      );
    });

    it('leaves a 204 alone — there is nothing to envelope', () => {
      const logout = operations.find(
        ({ path, method }) => path === '/api/auth/logout' && method === 'post',
      );
      expect(logout?.operation.responses?.['204']).not.toHaveProperty('content');
    });
  });
});
