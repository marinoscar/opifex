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
  authHeader,
  TestUser,
} from '../helpers/auth-mock.helper';

/**
 * #346's acceptance criteria, over real HTTP against the real route.
 *
 * The guard's own unit spec proves it refuses correctly. This proves it is
 * WIRED — that `@Auth({ interactive: true })` on
 * `OperatorSettingsController.patch` actually puts it in the request pipeline,
 * behind authentication and behind the permission check, and that the three
 * credential kinds are distinguishable by the time it runs. A guard that
 * refuses perfectly and is attached to nothing is precisely the failure VISION
 * §8 names: "the appearance of guardrails and none of the substance".
 *
 * Why this endpoint and not a fixture route: the wiring IS the claim. A test
 * route decorated in this spec would prove the decorator works and say nothing
 * about whether anybody remembered to apply it to the one path that matters.
 */
describe('Operator settings writes require an interactive session (#346)', () => {
  let context: TestContext;
  let jwt: JwtService;

  const PAT = 'pat_interactive_guard_fixture_token';

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
    jwt = context.module.get<JwtService>(JwtService);
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    givenAnEmptySettingsOverlay();
  });

  /**
   * Enough of `operator_settings` for the read and write paths to work.
   *
   * No rows and revision 1, so every key resolves from the environment and a
   * `PATCH` is a first write.
   */
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
        if (Array.isArray(arg)) {
          return Promise.all(arg);
        }
        return arg;
      },
    );
  }

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
              name: 'interactive-guard fixture',
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

  /** The `audit_events` rows this guard wrote, if any. */
  function refusalRows(): Array<Record<string, any>> {
    return (prismaMock.auditEvent.create as jest.Mock).mock.calls
      .map((call) => call[0].data)
      .filter((data) => data.action === 'auth.non-interactive-refused');
  }

  const BODY = { 'dispatch.enabled': true };

  describe('a personal access token', () => {
    it('is refused on PATCH with 403', async () => {
      // The admin here holds `system_settings:write`, so nothing but the
      // credential kind is standing between this request and a written row.
      // That is the point: a PAT is not a weaker admin, it is the same admin
      // with nobody at the keyboard.
      const admin = await createMockAdminUser(context);
      await givenLivePatFor(admin.id);

      const response = await request(context.app.getHttpServer())
        .patch('/api/operator-settings')
        .set('Authorization', `Bearer ${PAT}`)
        .send(BODY)
        .expect(403);

      // The whole phrase: the generic half of the refusal names both kinds it
      // refuses, so the bare noun matches even when the message has stopped
      // saying which credential was actually presented.
      expect(response.body.message).toContain(
        'Refused: PATCH /api/operator-settings from a personal access token.',
      );
      expect(response.body.message).toContain('VISION §8');
      expect(prismaMock.operatorSetting.upsert).not.toHaveBeenCalled();
    });

    it('may still read', async () => {
      const admin = await createMockAdminUser(context);
      await givenLivePatFor(admin.id);

      await request(context.app.getHttpServer())
        .get('/api/operator-settings')
        .set('Authorization', `Bearer ${PAT}`)
        .expect(200);
    });

    it('leaves an audit row behind when refused', async () => {
      const admin = await createMockAdminUser(context);
      await givenLivePatFor(admin.id);

      await request(context.app.getHttpServer())
        .patch('/api/operator-settings')
        .set('Authorization', `Bearer ${PAT}`)
        .send(BODY)
        .expect(403);

      const rows = refusalRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].actorUserId).toBe(admin.id);
      expect(rows[0].targetId).toBe('PATCH /api/operator-settings');
      expect(rows[0].meta.credentialKind).toBe('personal-access-token');
      expect(rows[0].meta.bodyKeys).toEqual(['dispatch.enabled']);
    });
  });

  describe('a device-flow token', () => {
    it('is refused on PATCH with 403', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .patch('/api/operator-settings')
        .set(authHeader(tokenFor(admin, 'device-code')))
        .send(BODY)
        .expect(403);

      expect(response.body.message).toContain(
        'Refused: PATCH /api/operator-settings from a device-flow token.',
      );
      expect(response.body.message).toContain('VISION §8');
      expect(prismaMock.operatorSetting.upsert).not.toHaveBeenCalled();
    });

    it('may still read', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .get('/api/operator-settings')
        .set(authHeader(tokenFor(admin, 'device-code')))
        .expect(200);
    });

    it('leaves an audit row behind when refused', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/operator-settings')
        .set(authHeader(tokenFor(admin, 'device-code')))
        .send(BODY)
        .expect(403);

      const rows = refusalRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].meta.credentialKind).toBe('device-code');
    });
  });

  describe('an interactive session', () => {
    it('may write', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/operator-settings')
        .set(authHeader(tokenFor(admin, 'interactive')))
        .send(BODY)
        .expect(200);

      expect(prismaMock.operatorSetting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key: 'dispatch.enabled' } }),
      );
      expect(refusalRows()).toHaveLength(0);
    });

    it('may read', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .get('/api/operator-settings')
        .set(authHeader(tokenFor(admin, 'interactive')))
        .expect(200);
    });
  });

  describe('a token carrying no credential claim', () => {
    it('is refused, because unproven is not the same as interactive', async () => {
      // `createMockAdminUser` mints exactly what every token minted before
      // #346 shipped looks like: no `cred` at all. Refusing it is the
      // fail-closed choice, and the cost is bounded by the access-token TTL.
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .patch('/api/operator-settings')
        .set(authHeader(admin.accessToken))
        .send(BODY)
        .expect(403);

      expect(response.body.message).toContain(
        'cannot be shown to be an interactive session',
      );
    });
  });

  describe('the order the guards run in', () => {
    it('answers 401, not a credential refusal, when nothing is presented', async () => {
      // If the interactive check ran before `JwtAuthGuard`, an anonymous
      // request would be refused for holding the wrong kind of credential
      // rather than none — and refused on the strength of a request property
      // nothing had populated yet.
      await request(context.app.getHttpServer())
        .patch('/api/operator-settings')
        .send(BODY)
        .expect(401);

      expect(refusalRows()).toHaveLength(0);
    });
  });
});
