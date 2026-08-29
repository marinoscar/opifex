import { JwtService } from '@nestjs/jwt';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockAdminUser,
  authHeader,
  TestUser,
} from '../helpers/auth-mock.helper';
import { OperatorSettingsController } from '../../src/settings/operator-settings/operator-settings.controller';
import { OperatorProbesService } from '../../src/settings/operator-settings/probes/operator-probes.service';

/** Where `@ApiResponse` (and so `@ApiDataResponse`) stores what it documented. */
const SWAGGER_API_RESPONSE = 'swagger/apiResponse';

/**
 * The status codes the Control Center's own routes actually answer (#387).
 *
 * ## Why over HTTP, and not off the decorator
 *
 * `POST /api/operator-settings/probes/:probe` answered 201 — Nest's `@Post()`
 * default — while `@ApiDataResponse` on the same handler documented 200. A
 * test that read `@HttpCode`'s metadata would have been GREEN throughout that
 * bug and green after the fix, because the bug was the ABSENCE of the
 * decorator: there was no metadata to disagree with. Only the response line
 * itself can tell the two states apart, so every case here goes through the
 * real Fastify pipeline, the real guards and the real interceptors, and reads
 * the status off the wire.
 *
 * ## Why it is worth a test at all
 *
 * This is the one kind of contract drift `openapi:lint` cannot see: a document
 * promising 200 for a route that answers 201 is a perfectly valid document,
 * and so is one promising 201. The published `/api/docs` contract is what an
 * SDK is generated from, and a generated client treats an undocumented status
 * as a failure — a probe that worked would surface as a probe that broke.
 *
 * ## The table is exhaustive on purpose
 *
 * `covers every route the controller declares` fails when a route is added
 * without an entry here, so the next POST on this controller has to state its
 * status deliberately rather than inherit 201 by silence.
 */
describe('Operator settings routes answer the status they document (#387)', () => {
  let context: TestContext;
  let jwt: JwtService;

  interface RouteCase {
    /** The controller method, so the OpenAPI metadata can be read off it. */
    handler: string;
    method: 'get' | 'post' | 'patch';
    path: string;
    body?: Record<string, unknown>;
    expected: number;
    /** Why this code, in one line. */
    because: string;
  }

  const ROUTES: RouteCase[] = [
    {
      handler: 'list',
      method: 'get',
      path: '/api/operator-settings',
      expected: 200,
      because: 'a read',
    },
    {
      handler: 'patch',
      method: 'patch',
      path: '/api/operator-settings',
      body: { 'dispatch.enabled': true },
      expected: 200,
      because:
        'PATCH already defaults to 200 in Nest, and the document says 200 — ' +
        'the rows it writes are an overlay on a collection that already ' +
        'exists, and the body returned is the whole re-resolved document ' +
        'rather than anything created',
    },
    {
      handler: 'listSupervisorModels',
      method: 'get',
      path: '/api/operator-settings/supervisor-models',
      expected: 200,
      because: 'a read',
    },
    {
      handler: 'probe',
      method: 'post',
      path: '/api/operator-settings/probes/git',
      // `{}`, not an absent body, because that is what the web client sends
      // and what the route actually accepts: `@ApiBody({ required: false })`
      // says the body is optional, but the global `ZodValidationPipe` hands
      // `undefined` to a `z.object` schema and gets a 400. That mismatch is
      // real and is NOT #387 — noted here so this suite measures the status
      // code rather than accidentally re-reporting it.
      body: {},
      expected: 200,
      because:
        'a probe creates nothing — it runs a check and reports what it found, ' +
        'so 201 would name a resource that does not exist',
    },
  ];

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
    jwt = context.module.get<JwtService>(JwtService);

    // Nothing here may spawn `git`, `claude`, or reach a vendor. The probe
    // service is stubbed at its one entry point so this suite measures the
    // ROUTE, not the check — and so it cannot go red on a container that has
    // no `git` on its PATH.
    jest
      .spyOn(context.module.get(OperatorProbesService), 'run')
      .mockImplementation(async (probe) => ({
        probe,
        ok: true,
        detail: 'stubbed for the status-code suite',
        checkedAt: new Date().toISOString(),
        skipped: false,
      }));
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    givenAnEmptySettingsOverlay();
  });

  /** No rows and revision 1: every key resolves from the environment. */
  function givenAnEmptySettingsOverlay(): void {
    (prismaMock.operatorSetting.findMany as jest.Mock).mockResolvedValue([]);
    (
      prismaMock.operatorSettingsRevision.findUnique as jest.Mock
    ).mockResolvedValue({ revision: BigInt(1) });
    (prismaMock.operatorSetting.upsert as jest.Mock).mockResolvedValue({});
    (prismaMock.operatorSettingsRevision.update as jest.Mock).mockResolvedValue(
      { revision: BigInt(2) },
    );
    (prismaMock.auditEvent.create as jest.Mock).mockResolvedValue({});
    (prismaMock.$transaction as jest.Mock).mockImplementation(
      async (arg: unknown) => {
        if (typeof arg === 'function') {
          return (arg as (tx: unknown) => unknown)(prismaMock);
        }
        if (Array.isArray(arg)) return Promise.all(arg);
        return arg;
      },
    );
  }

  /** The `cred` claim a real browser login mints; the PATCH demands it. */
  function tokenFor(user: TestUser): string {
    return jwt.sign({
      sub: user.id,
      email: user.email,
      roles: user.roles,
      cred: 'interactive',
    });
  }

  function send(route: RouteCase, token: string) {
    const call = request(context.app.getHttpServer())
      [route.method](route.path)
      .set(authHeader(token));

    return route.body ? call.send(route.body) : call;
  }

  /** The 2xx codes `@ApiResponse`/`@ApiDataResponse` put in the document. */
  function documentedSuccessStatuses(handler: string): number[] {
    const prototype = OperatorSettingsController.prototype as unknown as Record<
      string,
      object
    >;
    const responses = (Reflect.getMetadata(
      SWAGGER_API_RESPONSE,
      prototype[handler]!,
    ) ?? {}) as Record<string, unknown>;

    return Object.keys(responses)
      .map(Number)
      .filter((status) => status >= 200 && status < 300);
  }

  describe.each(ROUTES)('$method $path', (route) => {
    it(`answers ${route.expected} — ${route.because}`, async () => {
      const admin = await createMockAdminUser(context);

      const response = await send(route, tokenFor(admin));

      expect(response.status).toBe(route.expected);
      // The envelope is still the envelope: a status assertion that passed
      // because the request had failed differently would be worthless.
      expect(response.body).toHaveProperty('data');
    });

    it('documents exactly that status in the OpenAPI document', () => {
      // The other half of the pair. Together these two say the contract and
      // the implementation agree; either alone says only that one of them
      // holds still.
      expect(documentedSuccessStatuses(route.handler)).toEqual([
        route.expected,
      ]);
    });
  });

  it('covers every route the controller declares', () => {
    const prototype = OperatorSettingsController.prototype as unknown as Record<
      string,
      object
    >;

    const declared = Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      .filter(
        (name) =>
          Reflect.getMetadata(PATH_METADATA, prototype[name]!) !== undefined &&
          Reflect.getMetadata(METHOD_METADATA, prototype[name]!) !== undefined,
      );

    // A route added without a case above fails here rather than shipping with
    // whatever status Nest defaulted it to.
    expect(declared.sort()).toEqual(ROUTES.map((r) => r.handler).sort());
  });

  it('still answers 400 for an unknown probe name', async () => {
    // The fixed success code must not have moved the failure code with it: an
    // unrecognised probe is a malformed request against a closed set, not a
    // 200 carrying a sad result and not a 404.
    const admin = await createMockAdminUser(context);

    const response = await request(context.app.getHttpServer())
      .post('/api/operator-settings/probes/not-a-probe')
      .set(authHeader(tokenFor(admin)))
      .send({})
      .expect(400);

    expect(response.body.message).toContain('is not a probe');
  });
});
