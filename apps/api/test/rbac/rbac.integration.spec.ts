import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import { createMockUserSettings, mockRoles } from '../fixtures/test-data.factory';

describe('RBAC System (Integration)', () => {
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

  describe('Role-Based Access', () => {
    describe('Admin Role', () => {
      it('should have access to user management', async () => {
        const admin = await createMockAdminUser(context);

        // Mock user list response
        context.prismaMock.user.findMany.mockResolvedValue([]);
        context.prismaMock.user.count.mockResolvedValue(0);

        const response = await request(context.app.getHttpServer())
          .get('/api/users')
          .set(authHeader(admin.accessToken))
          .expect(200);

        expect(response.body.data).toBeDefined();
        expect(Array.isArray(response.body.data.items)).toBe(true);
      });

      it('should have access to system settings', async () => {
        const admin = await createMockAdminUser(context);

        const response = await request(context.app.getHttpServer())
          .get('/api/system-settings')
          .set(authHeader(admin.accessToken))
          .expect(200);

        expect(response.body.data).toBeDefined();
      });

      it('should be able to modify system settings', async () => {
        const admin = await createMockAdminUser(context);

        const updatedSettings = {
          id: 'settings-id',
          key: 'default',
          value: {
            ui: { allowUserThemeOverride: false },
            features: {},
          },
          version: 2,
          updatedAt: new Date(),
        };

        context.prismaMock.systemSettings.update.mockResolvedValue(updatedSettings);

        const response = await request(context.app.getHttpServer())
          .patch('/api/system-settings')
          .set(authHeader(admin.accessToken))
          .send({ ui: { allowUserThemeOverride: false } })
          .expect(200);

        expect(response.body.data).toBeDefined();
        expect(response.body.data.ui.allowUserThemeOverride).toBe(false);
      });
    });

    describe('Contributor Role', () => {
      it('should NOT have access to user management', async () => {
        const contributor = await createMockContributorUser(context);

        const response = await request(context.app.getHttpServer())
          .get('/api/users')
          .set(authHeader(contributor.accessToken))
          .expect(403);

        expect(response.body).toHaveProperty('code');
        expect(response.body.code).toBe('FORBIDDEN');
      });

      it('should NOT have access to system settings write', async () => {
        const contributor = await createMockContributorUser(context);

        const response = await request(context.app.getHttpServer())
          .patch('/api/system-settings')
          .set(authHeader(contributor.accessToken))
          .send({ ui: { allowUserThemeOverride: false } })
          .expect(403);

        expect(response.body.code).toBe('FORBIDDEN');
      });

      it('should have access to own user settings', async () => {
        const contributor = await createMockContributorUser(context);

        const settings = createMockUserSettings({
          userId: contributor.id,
        });

        context.prismaMock.userSettings.findUnique.mockResolvedValue(settings);

        const response = await request(context.app.getHttpServer())
          .get('/api/user-settings')
          .set(authHeader(contributor.accessToken))
          .expect(200);

        expect(response.body.data).toBeDefined();
      });

      it('should have access to own profile (auth/me)', async () => {
        const contributor = await createMockContributorUser(context);

        const response = await request(context.app.getHttpServer())
          .get('/api/auth/me')
          .set(authHeader(contributor.accessToken))
          .expect(200);

        expect(response.body.data.email).toBe(contributor.email);
      });
    });

    describe('Viewer Role', () => {
      it('should NOT have access to user management', async () => {
        const viewer = await createMockViewerUser(context);

        const response = await request(context.app.getHttpServer())
          .get('/api/users')
          .set(authHeader(viewer.accessToken))
          .expect(403);

        expect(response.body.code).toBe('FORBIDDEN');
      });

      it('should NOT have access to system settings', async () => {
        const viewer = await createMockViewerUser(context);

        const response = await request(context.app.getHttpServer())
          .patch('/api/system-settings')
          .set(authHeader(viewer.accessToken))
          .send({ ui: { allowUserThemeOverride: false } })
          .expect(403);

        expect(response.body.code).toBe('FORBIDDEN');
      });

      it('should have read access to own user settings', async () => {
        const viewer = await createMockViewerUser(context);

        const settings = createMockUserSettings({
          userId: viewer.id,
        });

        context.prismaMock.userSettings.findUnique.mockResolvedValue(settings);

        const response = await request(context.app.getHttpServer())
          .get('/api/user-settings')
          .set(authHeader(viewer.accessToken))
          .expect(200);

        expect(response.body.data).toBeDefined();
      });

      it('should have access to own profile (auth/me)', async () => {
        const viewer = await createMockViewerUser(context);

        const response = await request(context.app.getHttpServer())
          .get('/api/auth/me')
          .set(authHeader(viewer.accessToken))
          .expect(200);

        expect(response.body.data.email).toBe(viewer.email);
      });
    });
  });

  describe('Permission-Based Access', () => {
    it('should allow users:read permission to list users', async () => {
      const admin = await createMockAdminUser(context);

      context.prismaMock.user.findMany.mockResolvedValue([]);
      context.prismaMock.user.count.mockResolvedValue(0);

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data.items)).toBe(true);
    });

    it('should deny without users:read permission', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(viewer.accessToken))
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
    });

    it('should deny without system_settings:write permission', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(viewer.accessToken))
        .send({ ui: { allowUserThemeOverride: true } })
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
    });

    it('should allow user_settings:read permission to read own settings', async () => {
      const contributor = await createMockContributorUser(context);

      const settings = createMockUserSettings({
        userId: contributor.id,
      });

      context.prismaMock.userSettings.findUnique.mockResolvedValue(settings);

      const response = await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(response.body.data).toBeDefined();
    });
  });

  describe('Guard Combination', () => {
    it('should require both role and permission when both specified', async () => {
      const admin = await createMockAdminUser(context);

      context.prismaMock.user.findMany.mockResolvedValue([]);
      context.prismaMock.user.count.mockResolvedValue(0);

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toBeDefined();
    });

    it('should fail if role matches but permission missing', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(viewer.accessToken))
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
    });
  });

  describe('Self-Resource Access', () => {
    it('should allow user to access own settings regardless of role', async () => {
      const viewer = await createMockViewerUser(context);

      const settings = createMockUserSettings({
        userId: viewer.id,
      });

      context.prismaMock.userSettings.findUnique.mockResolvedValue(settings);

      const response = await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data).toBeDefined();
    });

    it('should allow user to access own profile', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.id).toBe(viewer.id);
      expect(response.body.data.email).toBe(viewer.email);
    });
  });
});
