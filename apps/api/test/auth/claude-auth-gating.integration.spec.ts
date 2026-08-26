import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
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
  createMockContributorUser,
  authHeader,
  TestUser,
} from '../helpers/auth-mock.helper';
import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { RBAC_EXTENSION_KEY } from '../../src/auth/decorators/auth.decorator';
import { ClaudeAuthController } from '../../src/settings/operator-settings/claude-auth/claude-auth.controller';
import { PERMISSIONS } from '../../src/common/constants/roles.constants';

/** Where `@ApiExtension` stores what it stamped. */
const SWAGGER_API_EXTENSION = 'swagger/apiExtension';

/** Where `@HttpCode` stores its override, and where `@ApiResponse` stores its. */
const HTTP_CODE_METADATA = '__httpCode__';
const SWAGGER_API_RESPONSE = 'swagger/apiResponse';

/**
 * The Claude sign-in routes are gated exactly as a secret write is (#386).
 *
 * ## Why this is an HTTP test and not a decorator assertion
 *
 * The wiring IS the claim. Reading `@Auth({ interactive: true })` off the
 * controller with `Reflect.getMetadata` would prove that the decorator was
 * typed, not that the guard is in the pipeline, behind authentication, and
 * ahead of anything that spawns a process. VISION §8's phrase for a guard that
 * refuses perfectly and is attached to nothing — "the appearance of guardrails
 * and none of the substance" — is a description of exactly that test.
 *
 * ## Why it matters more here than on `PATCH /api/operator-settings`
 *
 * This flow ends in a write to `runners.claudeCodeLocal.oauthToken`, which is
 * a secret key. If it were reachable with a lighter credential than the
 * `PATCH` that writes the same key, the lock on `PATCH` would be decorative:
 * an agent holding an Admin-scoped personal access token could simply come in
 * through this door instead. So every route here carries
 * `system_settings:write` + `operator_settings:write_secret` +
 * `interactive: true`, including the poll and the cancel.
 *
 * ## Nothing here spawns a CLI
 *
 * Every request below is refused before the handler runs, which is the point:
 * a refusal that happens after a `claude` process has been started is not a
 * refusal, it is a leak with a 403 attached. The absence of a spawned process
 * is asserted indirectly — a request that reached the handler would take
 * seconds and answer 201 or 409, not milliseconds and 403.
 */
describe('Claude sign-in requires a secret-write, interactive credential (#386)', () => {
  let context: TestContext;
  let jwt: JwtService;

  const PAT = 'pat_claude_auth_gating_fixture_token';
  const SESSION = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

  const ROUTES = [
    {
      method: 'post' as const,
      path: '/api/operator-settings/claude-auth/start',
    },
    {
      method: 'get' as const,
      path: `/api/operator-settings/claude-auth/${SESSION}`,
    },
    {
      method: 'post' as const,
      path: `/api/operator-settings/claude-auth/${SESSION}/code`,
    },
    {
      method: 'delete' as const,
      path: `/api/operator-settings/claude-auth/${SESSION}`,
    },
  ];

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
    jwt = context.module.get<JwtService>(JwtService);
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    (prismaMock.operatorSetting.findMany as jest.Mock).mockResolvedValue([]);
    (
      prismaMock.operatorSettingsRevision.findUnique as jest.Mock
    ).mockResolvedValue({ revision: BigInt(1) });
    (prismaMock.auditEvent.create as jest.Mock).mockResolvedValue({});
  });

  /** An access token carrying the `cred` claim a real login would mint. */
  function tokenFor(user: TestUser, cred: 'interactive' | 'device-code') {
    return jwt.sign({
      sub: user.id,
      email: user.email,
      roles: user.roles,
      cred,
    });
  }

  /** A live personal access token owned by the given admin. */
  async function givenLivePatFor(userId: string): Promise<void> {
    const fullUser = await (prismaMock.user.findUnique as jest.Mock)({
      where: { id: userId },
    });
    const expected = createHash('sha256').update(PAT).digest('hex');

    (prismaMock.personalAccessToken.findUnique as jest.Mock).mockImplementation(
      async ({ where }: { where: { tokenHash: string } }) =>
        where.tokenHash === expected
          ? {
              id: randomUUID(),
              userId,
              name: 'claude-auth gating fixture',
              tokenHash: expected,
              tokenPrefix: PAT.slice(0, 8),
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              lastUsedAt: null,
              revokedAt: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              user: fullUser,
            }
          : null,
    );
    (prismaMock.personalAccessToken.update as jest.Mock).mockResolvedValue({});
  }

  function refusalRows(): Array<Record<string, any>> {
    return (prismaMock.auditEvent.create as jest.Mock).mock.calls
      .map((call) => call[0].data)
      .filter((data) => data.action === 'auth.non-interactive-refused');
  }

  function send(
    route: (typeof ROUTES)[number],
    headers: Record<string, string>,
  ) {
    return request(context.app.getHttpServer())
      [route.method](route.path)
      .set(headers)
      .send(route.path.endsWith('/code') ? { code: 'whatever' } : undefined);
  }

  describe.each(ROUTES)('$method $path', (route) => {
    it('refuses a personal access token with 403', async () => {
      // The admin here holds every permission the route asks for. Only the
      // credential KIND stands between this request and a spawned `claude`
      // minting a year-long subscription token.
      const admin = await createMockAdminUser(context);
      await givenLivePatFor(admin.id);

      const response = await send(route, {
        Authorization: `Bearer ${PAT}`,
      }).expect(403);

      expect(response.body.message).toContain('from a personal access token.');
      expect(response.body.message).toContain('VISION §8');
    });

    it('refuses a device-flow token with 403', async () => {
      const admin = await createMockAdminUser(context);

      const response = await send(
        route,
        authHeader(tokenFor(admin, 'device-code')),
      ).expect(403);

      expect(response.body.message).toContain('from a device-flow token.');
    });

    it('refuses an interactive user who lacks the permissions', async () => {
      // A Contributor is interactive and is still not allowed near a
      // credential. This proves the permission guard is in the pipeline; WHICH
      // permissions it demands is asserted separately below, because a
      // Contributor is missing both of them and so cannot tell them apart.
      const contributor = await createMockContributorUser(context);

      await send(
        route,
        authHeader(tokenFor(contributor, 'interactive')),
      ).expect(403);
    });

    it('answers 401, not a credential refusal, when nothing is presented', async () => {
      // Guard ORDER. If the interactive check ran before `JwtAuthGuard`, an
      // anonymous request would be refused for holding the wrong kind of
      // credential rather than none — and on the strength of a request
      // property nothing had populated yet.
      await send(route, {}).expect(401);

      expect(refusalRows()).toHaveLength(0);
    });
  });

  describe('the two permissions it demands', () => {
    /*
     * Metadata rather than HTTP, and the reason is worth stating: every mock
     * role in this suite is missing BOTH `system_settings:write` and
     * `operator_settings:write_secret` or holds both, so no HTTP request can
     * distinguish "demands the second one" from "demands only the first". The
     * requests above prove the guard RUNS; these prove what it is checking.
     */
    it('requires the secret-write permission, not just the settings one', () => {
      const declared = Reflect.getMetadata(
        PERMISSIONS_KEY,
        ClaudeAuthController,
      ) as string[];

      expect(declared).toContain(PERMISSIONS.SYSTEM_SETTINGS_WRITE);
      // THE assertion. Without this, an operator who may tune a timeout could
      // also replace the credential the factory acts with — the split
      // ADR-0018 §6 exists to keep.
      expect(declared).toContain(PERMISSIONS.OPERATOR_SETTINGS_WRITE_SECRET);
    });

    it('advertises the same requirement in the OpenAPI document', () => {
      // `x-rbac` is what `/api/docs` renders and what a client generator
      // reads. A route whose docs understate its gate teaches operators to
      // build automation that cannot work. Read per handler, because
      // `@ApiExtension` stamps each method descriptor rather than the class.
      const handler = ClaudeAuthController.prototype.start;
      const extensions = Reflect.getMetadata(
        SWAGGER_API_EXTENSION,
        handler,
      ) as Record<string, { permissions: string[]; interactive?: true }>;

      const rbac = extensions[RBAC_EXTENSION_KEY];

      expect(rbac.permissions).toEqual([
        PERMISSIONS.SYSTEM_SETTINGS_WRITE,
        PERMISSIONS.OPERATOR_SETTINGS_WRITE_SECRET,
      ]);
      expect(rbac.interactive).toBe(true);
    });
  });

  describe('the status codes it documents are the ones it answers', () => {
    /*
     * The one kind of drift `openapi:lint` cannot catch, because both the
     * truth and the lie are valid OpenAPI: a POST documented as 200 while
     * Nest answers its default 201. The web client is generated from that
     * document, so a mismatch shows up as a client that treats a successful
     * call as a failure — and only at runtime.
     */
    const expectedFor = (
      handler: (...args: never[]) => unknown,
      verb: string,
    ) =>
      (Reflect.getMetadata(HTTP_CODE_METADATA, handler) as
        number | undefined) ?? (verb === 'POST' ? 201 : 200);

    it.each([
      ['POST', 'start'],
      ['GET', 'get'],
      ['POST', 'submitCode'],
      ['DELETE', 'cancel'],
    ])('%s %s', (verb, name) => {
      const handler = (
        ClaudeAuthController.prototype as unknown as Record<
          string,
          (...args: never[]) => unknown
        >
      )[name]!;

      const documented = Reflect.getMetadata(
        SWAGGER_API_RESPONSE,
        handler,
      ) as Record<string, unknown>;

      expect(Object.keys(documented)).toContain(
        String(expectedFor(handler, verb)),
      );
    });
  });

  it('records the refused attempt so "blocked" and "never tried" differ', async () => {
    const admin = await createMockAdminUser(context);
    await givenLivePatFor(admin.id);

    await request(context.app.getHttpServer())
      .post('/api/operator-settings/claude-auth/start')
      .set('Authorization', `Bearer ${PAT}`)
      .expect(403);

    const rows = refusalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(admin.id);
    expect(rows[0].targetId).toBe(
      'POST /api/operator-settings/claude-auth/start',
    );
    expect(rows[0].meta.credentialKind).toBe('personal-access-token');
  });

  it('never leaks the pasted code into the audit row', async () => {
    // The guard records body KEYS, never values (#337). On this route the
    // body is an authorization code — short-lived, but a credential all the
    // same, and `audit_events` is permanent.
    const admin = await createMockAdminUser(context);
    await givenLivePatFor(admin.id);

    await request(context.app.getHttpServer())
      .post(`/api/operator-settings/claude-auth/${SESSION}/code`)
      .set('Authorization', `Bearer ${PAT}`)
      .send({ code: 'a-real-looking-authorization-code' })
      .expect(403);

    const rows = refusalRows();
    expect(rows[0].meta.bodyKeys).toEqual(['code']);
    expect(JSON.stringify(rows)).not.toContain(
      'a-real-looking-authorization-code',
    );
  });
});
