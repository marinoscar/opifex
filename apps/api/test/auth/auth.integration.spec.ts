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
  createMockAdminUser,
  createMockInactiveUser,
  authHeader,
} from '../helpers/auth-mock.helper';

describe('Auth Controller (Integration)', () => {
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

  describe('GET /api/auth/providers', () => {
    it('should return list of enabled providers', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/auth/providers')
        .expect(200);

      expect(response.body.data).toBeDefined();
      expect(response.body.data.providers).toBeDefined();
      expect(Array.isArray(response.body.data.providers)).toBe(true);
    });

    it('should not require authentication', async () => {
      await request(context.app.getHttpServer())
        .get('/api/auth/providers')
        .expect(200);
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return current user for authenticated request', async () => {
      const user = await createMockTestUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        id: user.id,
        email: user.email,
        roles: expect.arrayContaining([{ name: 'viewer' }]),
      });
    });

    it('should return 401 without token', async () => {
      await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .expect(401);
    });

    it('should return 401 with invalid token', async () => {
      await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader('invalid-token'))
        .expect(401);
    });

    it('should return 401 for inactive user', async () => {
      const inactiveUser = await createMockInactiveUser(context);

      await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader(inactiveUser.accessToken))
        .expect(401);
    });

    it('should include permissions in response', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.permissions).toBeDefined();
      expect(Array.isArray(response.body.data.permissions)).toBe(true);
      expect(response.body.data.permissions.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('should return 200 with new access token when valid refresh token provided', async () => {
      const user = await createMockTestUser(context);

      // Mock a valid refresh token
      const mockRefreshToken = {
        id: 'token-1',
        userId: user.id,
        tokenHash: expect.any(String),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        revokedAt: null,
        createdAt: new Date(),
        user: {
          id: user.id,
          email: user.email,
          isActive: true,
          userRoles: [{ role: { name: 'viewer' } }],
        },
      };

      context.prismaMock.refreshToken.findUnique.mockResolvedValue(mockRefreshToken);
      context.prismaMock.refreshToken.update.mockResolvedValue({});
      context.prismaMock.refreshToken.create.mockResolvedValue({});

      const response = await request(context.app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', 'refresh_token=valid-refresh-token')
        .expect(200);

      // Response may be wrapped in data object or not depending on interceptor
      const responseData = response.body.data || response.body;
      expect(responseData).toHaveProperty('accessToken');
      expect(responseData).toHaveProperty('expiresIn');
      expect(typeof responseData.accessToken).toBe('string');
      expect(typeof responseData.expiresIn).toBe('number');
    });

    it('should return 401 with no refresh token cookie', async () => {
      const response = await request(context.app.getHttpServer())
        .post('/api/auth/refresh')
        .expect(401);

      expect(response.body).toHaveProperty('code');
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('No refresh token provided');
    });

    it('should return 401 with expired refresh token', async () => {
      const user = await createMockTestUser(context);

      const expiredToken = {
        id: 'token-1',
        userId: user.id,
        tokenHash: expect.any(String),
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago
        revokedAt: null,
        createdAt: new Date(),
        user: {
          id: user.id,
          email: user.email,
          isActive: true,
          userRoles: [{ role: { name: 'viewer' } }],
        },
      };

      context.prismaMock.refreshToken.findUnique.mockResolvedValue(expiredToken);

      const response = await request(context.app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', 'refresh_token=expired-token')
        .expect(401);

      expect(response.body.message).toContain('expired');
    });

    it('should return 401 with revoked refresh token', async () => {
      const user = await createMockTestUser(context);

      const revokedToken = {
        id: 'token-1',
        userId: user.id,
        tokenHash: expect.any(String),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        revokedAt: new Date(),
        createdAt: new Date(),
        user: {
          id: user.id,
          email: user.email,
          isActive: true,
          userRoles: [{ role: { name: 'viewer' } }],
        },
      };

      context.prismaMock.refreshToken.findUnique.mockResolvedValue(revokedToken);
      context.prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 0 });

      const response = await request(context.app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', 'refresh_token=revoked-token')
        .expect(401);

      expect(response.body.message).toContain('revoked');
    });

    it('should set new refresh token cookie on successful refresh', async () => {
      const user = await createMockTestUser(context);

      const mockRefreshToken = {
        id: 'token-1',
        userId: user.id,
        tokenHash: expect.any(String),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        revokedAt: null,
        createdAt: new Date(),
        user: {
          id: user.id,
          email: user.email,
          isActive: true,
          userRoles: [{ role: { name: 'viewer' } }],
        },
      };

      context.prismaMock.refreshToken.findUnique.mockResolvedValue(mockRefreshToken);
      context.prismaMock.refreshToken.update.mockResolvedValue({});
      context.prismaMock.refreshToken.create.mockResolvedValue({});

      const response = await request(context.app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', 'refresh_token=valid-token')
        .expect(200);

      // Check that Set-Cookie header is present
      expect(response.headers['set-cookie']).toBeDefined();
      const setCookieHeader = Array.isArray(response.headers['set-cookie'])
        ? response.headers['set-cookie'][0]
        : response.headers['set-cookie'];
      expect(setCookieHeader).toContain('refresh_token=');
      expect(setCookieHeader).toContain('HttpOnly');
    });

    it('should verify token is stored as hash not plaintext', async () => {
      const user = await createMockTestUser(context);

      const mockRefreshToken = {
        id: 'token-1',
        userId: user.id,
        tokenHash: 'hashed-value-12345',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        revokedAt: null,
        createdAt: new Date(),
        user: {
          id: user.id,
          email: user.email,
          isActive: true,
          userRoles: [{ role: { name: 'viewer' } }],
        },
      };

      context.prismaMock.refreshToken.findUnique.mockResolvedValue(mockRefreshToken);
      context.prismaMock.refreshToken.update.mockResolvedValue({});
      context.prismaMock.refreshToken.create.mockResolvedValue({});

      await request(context.app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', 'refresh_token=plain-token-value')
        .expect(200);

      // Verify findUnique was called with tokenHash (not the plain token)
      expect(context.prismaMock.refreshToken.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tokenHash: expect.not.stringContaining('plain-token-value'),
          },
        }),
      );
    });

    it('should detect token reuse attack and revoke all user tokens', async () => {
      const user = await createMockTestUser(context);

      const revokedToken = {
        id: 'token-1',
        userId: user.id,
        tokenHash: expect.any(String),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        revokedAt: new Date(Date.now() - 1000), // Already revoked
        createdAt: new Date(),
        user: {
          id: user.id,
          email: user.email,
          isActive: true,
          userRoles: [{ role: { name: 'viewer' } }],
        },
      };

      context.prismaMock.refreshToken.findUnique.mockResolvedValue(revokedToken);
      context.prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 3 });

      await request(context.app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', 'refresh_token=reused-token')
        .expect(401);

      // Verify all user tokens were revoked
      expect(context.prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
        where: {
          userId: user.id,
          revokedAt: null,
        },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should return 401 without authentication', async () => {
      await request(context.app.getHttpServer())
        .post('/api/auth/logout')
        .expect(401);
    });

    it('should return 204 and clear cookies with valid auth', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });

      const response = await request(context.app.getHttpServer())
        .post('/api/auth/logout')
        .set(authHeader(user.accessToken))
        .set('Cookie', 'refresh_token=valid-token')
        .expect(204);

      expect(response.body).toEqual({});

      // Verify cookie was cleared
      expect(response.headers['set-cookie']).toBeDefined();
      const setCookieHeader = Array.isArray(response.headers['set-cookie'])
        ? response.headers['set-cookie'][0]
        : response.headers['set-cookie'];
      expect(setCookieHeader).toContain('refresh_token=');
      expect(setCookieHeader).toMatch(/Max-Age=0|Expires=/); // Cookie cleared
    });

    it('should revoke refresh token on logout', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });

      await request(context.app.getHttpServer())
        .post('/api/auth/logout')
        .set(authHeader(user.accessToken))
        .set('Cookie', 'refresh_token=token-to-revoke')
        .expect(204);

      // Verify token was revoked
      expect(context.prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: user.id,
          }),
          data: { revokedAt: expect.any(Date) },
        }),
      );
    });

    it('should work even without refresh token cookie', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 0 });

      await request(context.app.getHttpServer())
        .post('/api/auth/logout')
        .set(authHeader(user.accessToken))
        .expect(204);

      // Should still call updateMany (revokes all tokens when no specific token)
      expect(context.prismaMock.refreshToken.updateMany).toHaveBeenCalled();
    });
  });

  describe('POST /api/auth/logout-all', () => {
    it('should return 401 without authentication', async () => {
      await request(context.app.getHttpServer())
        .post('/api/auth/logout-all')
        .expect(401);
    });

    it('should return 204 and revoke all user tokens', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 5 });

      const response = await request(context.app.getHttpServer())
        .post('/api/auth/logout-all')
        .set(authHeader(user.accessToken))
        .expect(204);

      expect(response.body).toEqual({});

      // Verify all tokens were revoked
      expect(context.prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
        where: {
          userId: user.id,
          revokedAt: null,
        },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('should clear refresh token cookie', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 3 });

      const response = await request(context.app.getHttpServer())
        .post('/api/auth/logout-all')
        .set(authHeader(user.accessToken))
        .set('Cookie', 'refresh_token=some-token')
        .expect(204);

      // Verify cookie was cleared
      expect(response.headers['set-cookie']).toBeDefined();
      const setCookieHeader = Array.isArray(response.headers['set-cookie'])
        ? response.headers['set-cookie'][0]
        : response.headers['set-cookie'];
      expect(setCookieHeader).toContain('refresh_token=');
    });

    it('should revoke all sessions from all devices', async () => {
      const user = await createMockTestUser(context);

      // Mock multiple active tokens (e.g., from different devices)
      context.prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 7 });

      await request(context.app.getHttpServer())
        .post('/api/auth/logout-all')
        .set(authHeader(user.accessToken))
        .expect(204);

      // Should revoke all non-revoked tokens for the user
      expect(context.prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
        where: {
          userId: user.id,
          revokedAt: null,
        },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });
});
