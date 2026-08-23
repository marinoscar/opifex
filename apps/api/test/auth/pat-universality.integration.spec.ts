import request from 'supertest';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockAdminUser } from '../helpers/auth-mock.helper';

/**
 * Proves the claim the OpenAPI document makes about personal access tokens.
 *
 * `src/openapi/document.ts` appends the `PAT-auth` scheme to EVERY authenticated
 * operation, and `info.description` states that a PAT is accepted on every
 * authenticated route with no narrower scope. That is a universal claim, and a
 * universal claim in published documentation has to be backed by something
 * better than reading the guard once.
 *
 * The mechanism it rests on: `JwtAuthGuard.canActivate` intercepts any
 * `Authorization: Bearer pat_…` header and resolves it through
 * `PatService.validateToken` BEFORE delegating to the JWT passport strategy,
 * setting the same `AuthenticatedUser` on the request that the strategy would —
 * so `RolesGuard` and `PermissionsGuard` see identical input either way. Every
 * authenticated route in this API is guarded by `JwtAuthGuard`, via `@Auth()` or
 * a direct `@UseGuards(JwtAuthGuard)`.
 *
 * These cases exercise a route from each of those two guard styles, on
 * controllers that have nothing to do with the PAT module.
 */
describe('PAT universality (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
  });

  const RAW_TOKEN = 'pat_universality_fixture_token';

  /**
   * Registers a live PAT whose owner is the given mock user, keyed by the same
   * SHA-256 hash `PatService.validateToken` computes.
   */
  async function givenLivePatFor(userId: string): Promise<void> {
    const fullUser = await (context.prismaMock.user.findUnique as jest.Mock)({
      where: { id: userId },
    });
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    (
      context.prismaMock.personalAccessToken.findUnique as jest.Mock
    ).mockImplementation(
      async ({ where }: { where: { tokenHash: string } }) => {
        const expected = createHash('sha256').update(RAW_TOKEN).digest('hex');
        if (where.tokenHash !== expected) return null;
        return {
          id: randomUUID(),
          userId,
          name: 'Universality fixture',
          tokenHash: expected,
          tokenPrefix: RAW_TOKEN.slice(0, 8),
          expiresAt,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          user: fullUser,
        };
      },
    );
    (
      context.prismaMock.personalAccessToken.update as jest.Mock
    ).mockResolvedValue({});
  }

  it('authenticates an @Auth()-guarded route on an unrelated controller', async () => {
    // GET /api/users is guarded by @Auth({ permissions: ['users:read'] }) — so
    // this also shows the permission guard resolving the PAT owner's grants.
    const user = await createMockAdminUser(context);
    await givenLivePatFor(user.id);

    (context.prismaMock.user.findMany as jest.Mock).mockResolvedValue([]);
    (context.prismaMock.user.count as jest.Mock).mockResolvedValue(0);

    await request(context.app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${RAW_TOKEN}`)
      .expect(200);
  });

  it('authenticates a route guarded by a bare @UseGuards(JwtAuthGuard) too', async () => {
    // GET /api/auth/me is the other guard style — no @Auth(), no RBAC guards.
    const user = await createMockAdminUser(context);
    await givenLivePatFor(user.id);

    const response = await request(context.app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${RAW_TOKEN}`)
      .expect(200);

    expect(response.body.data.id).toBe(user.id);
  });

  it('rejects a pat_ token that does not resolve, rather than falling through to JWT', async () => {
    (
      context.prismaMock.personalAccessToken.findUnique as jest.Mock
    ).mockResolvedValue(null);

    await request(context.app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', 'Bearer pat_not_a_real_token')
      .expect(401);
  });
});
