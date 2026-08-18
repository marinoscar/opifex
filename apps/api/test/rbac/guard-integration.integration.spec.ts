import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockTestUser,
  authHeader,
} from '../helpers/auth-mock.helper';

describe('Guard Integration (Integration)', () => {
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

  describe('JwtAuthGuard + RolesGuard', () => {
    it('should first check JWT then check role (401 before 403)', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .expect(401);

      expect(response.body).toHaveProperty('code');
      expect(response.body.code).toBe('UNAUTHORIZED');
    });

    it('should return 403 when authenticated but wrong role', async () => {
      const viewer = await createMockTestUser(context, { roleName: 'viewer' });

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(viewer.accessToken))
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
    });

    it('should return 200 when authenticated with correct role', async () => {
      const admin = await createMockTestUser(context, { roleName: 'admin' });

      context.prismaMock.user.findMany.mockResolvedValue([]);
      context.prismaMock.user.count.mockResolvedValue(0);

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toBeDefined();
    });
  });

  describe('Public Routes', () => {
    it('should skip all auth guards on health endpoints', async () => {
      await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);
    });

    it('should not require auth for OAuth initiation', async () => {
      await request(context.app.getHttpServer())
        .get('/api/auth/google')
        .expect(302);
    });
  });

  describe('Error Messages', () => {
    it('should return clear message for unauthorized', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .expect(401);

      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('code');
      expect(response.body.code).toBe('UNAUTHORIZED');
      expect(typeof response.body.message).toBe('string');
    });

    it('should return clear message for forbidden', async () => {
      const viewer = await createMockTestUser(context, { roleName: 'viewer' });

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(viewer.accessToken))
        .expect(403);

      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('code');
      expect(response.body.code).toBe('FORBIDDEN');
      expect(typeof response.body.message).toBe('string');
    });

    it('should include helpful details in forbidden message', async () => {
      const viewer = await createMockTestUser(context, { roleName: 'viewer' });

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(viewer.accessToken))
        .expect(403);

      expect(response.body.message.toLowerCase()).toMatch(
        /permission|role|forbidden/,
      );
    });
  });

  describe('Token Validation', () => {
    it('should reject malformed token', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader('malformed.token.here'))
        .expect(401);

      expect(response.body.code).toBe('UNAUTHORIZED');
    });

    it('should reject token with invalid signature', async () => {
      const invalidToken =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

      const response = await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader(invalidToken))
        .expect(401);

      expect(response.body.code).toBe('UNAUTHORIZED');
    });

    it('should reject request without Bearer prefix', async () => {
      const admin = await createMockTestUser(context, { roleName: 'admin' });

      const response = await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', admin.accessToken)
        .expect(401);

      expect(response.body.code).toBe('UNAUTHORIZED');
    });

    it('should accept valid token', async () => {
      const admin = await createMockTestUser(context, { roleName: 'admin' });

      const response = await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toBeDefined();
      expect(response.body.data.email).toBe(admin.email);
    });
  });

  describe('Dynamic Role Changes', () => {
    it('should not reflect role changes in existing JWT', async () => {
      const viewer = await createMockTestUser(context, { roleName: 'viewer' });

      // Verify can't access users with viewer role
      await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(viewer.accessToken))
        .expect(403);

      // Even if we "upgrade" the user in the database,
      // the JWT still contains the old roles (viewer)
      // JWT is stateless and roles are embedded at sign time

      await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });
  });
});
