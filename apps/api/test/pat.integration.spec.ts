import request from 'supertest';
import { randomUUID } from 'crypto';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from './helpers/test-app.helper';
import { resetPrismaMock } from './mocks/prisma.mock';
import { setupBaseMocks } from './fixtures/mock-setup.helper';
import {
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
  authHeader,
} from './helpers/auth-mock.helper';

describe('Personal Access Tokens (Integration)', () => {
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

  // ============================================================================
  // POST /api/pat
  // ============================================================================

  describe('POST /api/pat', () => {
    it('should return 401 when not authenticated', async () => {
      await request(context.app.getHttpServer())
        .post('/api/pat')
        .send({ name: 'Test Token', durationValue: 30, durationUnit: 'days' })
        .expect(401);
    });

    it('should create a PAT and return raw token with correct shape (201)', async () => {
      const user = await createMockAdminUser(context);

      const patId = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setDate(expiresAt.getDate() + 30);

      context.prismaMock.personalAccessToken.create.mockResolvedValue({
        id: patId,
        userId: user.id,
        name: 'My CI Token',
        tokenHash: 'sha256-hash-placeholder',
        tokenPrefix: 'pat_abcd',
        durationValue: 30,
        durationUnit: 'days',
        expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      const response = await request(context.app.getHttpServer())
        .post('/api/pat')
        .set(authHeader(user.accessToken))
        .send({ name: 'My CI Token', durationValue: 30, durationUnit: 'days' })
        .expect(201);

      expect(response.body.data).toHaveProperty('token');
      expect(response.body.data.token).toMatch(/^pat_/);
      expect(response.body.data).toHaveProperty('id', patId);
      expect(response.body.data).toHaveProperty('name', 'My CI Token');
      expect(response.body.data).toHaveProperty('tokenPrefix');
      expect(response.body.data).toHaveProperty('expiresAt');
      expect(response.body.data).toHaveProperty('createdAt');
    });

    it('should create a PAT for a contributor user', async () => {
      const user = await createMockContributorUser(context);

      const patId = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setDate(expiresAt.getDate() + 7);

      context.prismaMock.personalAccessToken.create.mockResolvedValue({
        id: patId,
        userId: user.id,
        name: 'Dev Token',
        tokenHash: 'hash',
        tokenPrefix: 'pat_1234',
        durationValue: 7,
        durationUnit: 'days',
        expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      const response = await request(context.app.getHttpServer())
        .post('/api/pat')
        .set(authHeader(user.accessToken))
        .send({ name: 'Dev Token', durationValue: 7, durationUnit: 'days' })
        .expect(201);

      expect(response.body.data.token).toMatch(/^pat_/);
    });

    it('should return 400 when name is missing', async () => {
      const user = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .post('/api/pat')
        .set(authHeader(user.accessToken))
        .send({ durationValue: 30, durationUnit: 'days' })
        .expect(400);
    });

    it('should return 400 when name is empty string', async () => {
      const user = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .post('/api/pat')
        .set(authHeader(user.accessToken))
        .send({ name: '', durationValue: 30, durationUnit: 'days' })
        .expect(400);
    });

    it('should return 400 when name exceeds 100 characters', async () => {
      const user = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .post('/api/pat')
        .set(authHeader(user.accessToken))
        .send({
          name: 'a'.repeat(101),
          durationValue: 30,
          durationUnit: 'days',
        })
        .expect(400);
    });

    it('should return 400 when durationValue is 0', async () => {
      const user = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .post('/api/pat')
        .set(authHeader(user.accessToken))
        .send({ name: 'Test', durationValue: 0, durationUnit: 'days' })
        .expect(400);
    });

    it('should return 400 when durationValue is 1000 (above max)', async () => {
      const user = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .post('/api/pat')
        .set(authHeader(user.accessToken))
        .send({ name: 'Test', durationValue: 1000, durationUnit: 'days' })
        .expect(400);
    });

    it('should return 400 when durationUnit is invalid', async () => {
      const user = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .post('/api/pat')
        .set(authHeader(user.accessToken))
        .send({ name: 'Test', durationValue: 30, durationUnit: 'weeks' })
        .expect(400);
    });

    it('should return 400 when durationValue is missing', async () => {
      const user = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .post('/api/pat')
        .set(authHeader(user.accessToken))
        .send({ name: 'Test', durationUnit: 'days' })
        .expect(400);
    });

    it('should return 400 when durationUnit is missing', async () => {
      const user = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .post('/api/pat')
        .set(authHeader(user.accessToken))
        .send({ name: 'Test', durationValue: 30 })
        .expect(400);
    });

    it('should accept durationUnit "minutes"', async () => {
      const user = await createMockAdminUser(context);

      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setMinutes(expiresAt.getMinutes() + 15);

      context.prismaMock.personalAccessToken.create.mockResolvedValue({
        id: randomUUID(),
        userId: user.id,
        name: 'Short Lived',
        tokenHash: 'hash',
        tokenPrefix: 'pat_aabb',
        durationValue: 15,
        durationUnit: 'minutes',
        expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      await request(context.app.getHttpServer())
        .post('/api/pat')
        .set(authHeader(user.accessToken))
        .send({ name: 'Short Lived', durationValue: 15, durationUnit: 'minutes' })
        .expect(201);
    });

    it('should accept durationUnit "months"', async () => {
      const user = await createMockAdminUser(context);

      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setMonth(expiresAt.getMonth() + 12);

      context.prismaMock.personalAccessToken.create.mockResolvedValue({
        id: randomUUID(),
        userId: user.id,
        name: 'Annual Token',
        tokenHash: 'hash',
        tokenPrefix: 'pat_ccdd',
        durationValue: 12,
        durationUnit: 'months',
        expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      await request(context.app.getHttpServer())
        .post('/api/pat')
        .set(authHeader(user.accessToken))
        .send({ name: 'Annual Token', durationValue: 12, durationUnit: 'months' })
        .expect(201);
    });
  });

  // ============================================================================
  // GET /api/pat
  // ============================================================================

  describe('GET /api/pat', () => {
    it('should return 401 when not authenticated', async () => {
      await request(context.app.getHttpServer())
        .get('/api/pat')
        .expect(401);
    });

    it('should return list of tokens for current user', async () => {
      const user = await createMockAdminUser(context);

      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setDate(expiresAt.getDate() + 30);

      const mockTokens = [
        {
          id: randomUUID(),
          name: 'CI Token',
          tokenPrefix: 'pat_ab12',
          durationValue: 30,
          durationUnit: 'days',
          expiresAt,
          lastUsedAt: null,
          createdAt: now,
          revokedAt: null,
        },
        {
          id: randomUUID(),
          name: 'Dev Token',
          tokenPrefix: 'pat_cd34',
          durationValue: 7,
          durationUnit: 'days',
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          lastUsedAt: new Date(now.getTime() - 60000),
          createdAt: now,
          revokedAt: null,
        },
      ];

      context.prismaMock.personalAccessToken.findMany.mockResolvedValue(mockTokens);

      const response = await request(context.app.getHttpServer())
        .get('/api/pat')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0]).toHaveProperty('id');
      expect(response.body.data[0]).toHaveProperty('name', 'CI Token');
      expect(response.body.data[0]).toHaveProperty('tokenPrefix', 'pat_ab12');
      expect(response.body.data[0]).toHaveProperty('expiresAt');
      expect(response.body.data[0]).toHaveProperty('createdAt');
      expect(response.body.data[0]).toHaveProperty('revokedAt');
      expect(response.body.data[0]).not.toHaveProperty('tokenHash');
    });

    it('should return empty array when user has no tokens', async () => {
      const user = await createMockViewerUser(context);

      context.prismaMock.personalAccessToken.findMany.mockResolvedValue([]);

      const response = await request(context.app.getHttpServer())
        .get('/api/pat')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data).toHaveLength(0);
    });

    it('should not include tokenHash in list response', async () => {
      const user = await createMockAdminUser(context);

      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setDate(expiresAt.getDate() + 30);

      context.prismaMock.personalAccessToken.findMany.mockResolvedValue([
        {
          id: randomUUID(),
          name: 'Secure Token',
          tokenPrefix: 'pat_ef56',
          durationValue: 30,
          durationUnit: 'days',
          expiresAt,
          lastUsedAt: null,
          createdAt: now,
          revokedAt: null,
        },
      ]);

      const response = await request(context.app.getHttpServer())
        .get('/api/pat')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data[0]).not.toHaveProperty('tokenHash');
    });
  });

  // ============================================================================
  // DELETE /api/pat/:id
  // ============================================================================

  describe('DELETE /api/pat/:id', () => {
    it('should return 401 when not authenticated', async () => {
      await request(context.app.getHttpServer())
        .delete(`/api/pat/${randomUUID()}`)
        .expect(401);
    });

    it('should revoke a token and return 204', async () => {
      const user = await createMockAdminUser(context);

      const patId = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setDate(expiresAt.getDate() + 30);

      const mockPat = {
        id: patId,
        userId: user.id,
        name: 'Token to Revoke',
        tokenHash: 'hash',
        tokenPrefix: 'pat_revk',
        durationValue: 30,
        durationUnit: 'days',
        expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      context.prismaMock.personalAccessToken.findFirst.mockResolvedValue(mockPat);
      context.prismaMock.personalAccessToken.update.mockResolvedValue({
        ...mockPat,
        revokedAt: now,
      });

      await request(context.app.getHttpServer())
        .delete(`/api/pat/${patId}`)
        .set(authHeader(user.accessToken))
        .expect(204);

      expect(context.prismaMock.personalAccessToken.update).toHaveBeenCalledWith({
        where: { id: patId },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('should return 404 for non-existent token', async () => {
      const user = await createMockAdminUser(context);

      context.prismaMock.personalAccessToken.findFirst.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete(`/api/pat/${randomUUID()}`)
        .set(authHeader(user.accessToken))
        .expect(404);
    });

    it('should return 404 for already revoked token', async () => {
      const user = await createMockAdminUser(context);

      const patId = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setDate(expiresAt.getDate() + 30);

      const mockPat = {
        id: patId,
        userId: user.id,
        name: 'Already Revoked',
        tokenHash: 'hash',
        tokenPrefix: 'pat_old',
        durationValue: 30,
        durationUnit: 'days',
        expiresAt,
        lastUsedAt: null,
        revokedAt: new Date(now.getTime() - 3600000), // revoked 1 hour ago
        createdAt: now,
        updatedAt: now,
      };

      context.prismaMock.personalAccessToken.findFirst.mockResolvedValue(mockPat);

      await request(context.app.getHttpServer())
        .delete(`/api/pat/${patId}`)
        .set(authHeader(user.accessToken))
        .expect(404);
    });

    it('should return 400 for invalid UUID format', async () => {
      const user = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .delete('/api/pat/not-a-valid-uuid')
        .set(authHeader(user.accessToken))
        .expect(400);
    });

    it('should not allow a user to revoke another user\'s token (returns 404)', async () => {
      const user = await createMockAdminUser(context);

      // findFirst returns null because it filters by userId
      context.prismaMock.personalAccessToken.findFirst.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete(`/api/pat/${randomUUID()}`)
        .set(authHeader(user.accessToken))
        .expect(404);
    });
  });
});
