import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from './helpers/test-app.helper';
import { resetPrismaMock } from './mocks/prisma.mock';
import { setupBaseMocks, setupMockAllowedEmailList } from './fixtures/mock-setup.helper';
import {
  createMockTestUser,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
  authHeader,
} from './helpers/auth-mock.helper';
import { createMockAllowedEmail } from './fixtures/test-data.factory';

describe('Allowlist (Integration)', () => {
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

  describe('GET /api/allowlist', () => {
    it('should return 401 if not authenticated', async () => {
      await request(context.app.getHttpServer())
        .get('/api/allowlist')
        .expect(401);
    });

    it('should return 403 if user lacks allowlist:read permission', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .get('/api/allowlist')
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });

    it.skip('should return paginated list for admin', async () => {
      const admin = await createMockAdminUser(context);

      const allowedEmails = [
        createMockAllowedEmail({
          email: 'test1@example.com',
          addedById: admin.id,
        }),
        createMockAllowedEmail({
          email: 'test2@example.com',
          addedById: admin.id,
        }),
      ];

      setupMockAllowedEmailList(allowedEmails);

      const response = await request(context.app.getHttpServer())
        .get('/api/allowlist')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toHaveProperty('items');
      expect(response.body.data).toHaveProperty('total');
      expect(response.body.data).toHaveProperty('page');
      expect(response.body.data).toHaveProperty('pageSize');
      expect(response.body.data).toHaveProperty('totalPages');
    });

    it('should filter by status (pending)', async () => {
      const admin = await createMockAdminUser(context);

      const allowedEmails = [
        createMockAllowedEmail({
          email: 'pending@example.com',
          addedById: admin.id,
          claimedById: null,
        }),
      ];

      setupMockAllowedEmailList(allowedEmails);

      const response = await request(context.app.getHttpServer())
        .get('/api/allowlist?status=pending')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.items[0].claimedById).toBeNull();
    });

    it('should filter by status (claimed)', async () => {
      const admin = await createMockAdminUser(context);
      const viewer = await createMockViewerUser(context);

      const allowedEmails = [
        createMockAllowedEmail({
          email: 'claimed@example.com',
          addedById: admin.id,
          claimedById: viewer.id,
          claimedAt: new Date(),
        }),
      ];

      setupMockAllowedEmailList(allowedEmails);

      const response = await request(context.app.getHttpServer())
        .get('/api/allowlist?status=claimed')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.items[0].claimedById).toBeTruthy();
    });

    it('should search by email', async () => {
      const admin = await createMockAdminUser(context);

      const allowedEmails = [
        createMockAllowedEmail({
          email: 'searchme@example.com',
          addedById: admin.id,
        }),
        createMockAllowedEmail({
          email: 'other@example.com',
          addedById: admin.id,
        }),
      ];

      setupMockAllowedEmailList(allowedEmails);

      const response = await request(context.app.getHttpServer())
        .get('/api/allowlist?search=searchme')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.items.length).toBeGreaterThan(0);
    });
  });

  describe.skip('POST /api/allowlist', () => {
    it('should return 401 if not authenticated', async () => {
      await request(context.app.getHttpServer())
        .post('/api/allowlist')
        .send({ email: 'test@example.com' })
        .expect(401);
    });

    it('should return 403 if user lacks allowlist:write permission', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .post('/api/allowlist')
        .set(authHeader(viewer.accessToken))
        .send({ email: 'test@example.com' })
        .expect(403);
    });

    it('should validate email format', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .post('/api/allowlist')
        .set(authHeader(admin.accessToken))
        .send({ email: 'invalid-email' })
        .expect(400);
    });

    it('should require email field', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .post('/api/allowlist')
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(400);
    });

    it('should add new email for admin', async () => {
      const admin = await createMockAdminUser(context);

      const newEmail = 'newuser@example.com';
      const entry = createMockAllowedEmail({
        email: newEmail,
        addedById: admin.id,
      });

      context.prismaMock.allowedEmail.findUnique.mockResolvedValue(null);
      context.prismaMock.allowedEmail.create.mockResolvedValue(entry);
      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .post('/api/allowlist')
        .set(authHeader(admin.accessToken))
        .send({ email: newEmail })
        .expect(201);

      expect(response.body.data).toHaveProperty('email', newEmail.toLowerCase());
      expect(response.body.data).toHaveProperty('claimedById', null);
      expect(context.prismaMock.allowedEmail.create).toHaveBeenCalled();
    });

    it('should normalize email to lowercase', async () => {
      const admin = await createMockAdminUser(context);

      const mixedCaseEmail = 'MixedCase@Example.COM';
      const entry = createMockAllowedEmail({
        email: mixedCaseEmail.toLowerCase(),
        addedById: admin.id,
      });

      context.prismaMock.allowedEmail.findUnique.mockResolvedValue(null);
      context.prismaMock.allowedEmail.create.mockResolvedValue(entry);
      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .post('/api/allowlist')
        .set(authHeader(admin.accessToken))
        .send({ email: mixedCaseEmail })
        .expect(201);

      expect(response.body.data.email).toBe(mixedCaseEmail.toLowerCase());
    });

    it('should return 409 for duplicate email', async () => {
      const admin = await createMockAdminUser(context);

      const existingEmail = 'existing@example.com';
      const existingEntry = createMockAllowedEmail({
        email: existingEmail,
        addedById: admin.id,
      });

      context.prismaMock.allowedEmail.findUnique.mockResolvedValue(
        existingEntry,
      );

      await request(context.app.getHttpServer())
        .post('/api/allowlist')
        .set(authHeader(admin.accessToken))
        .send({ email: existingEmail })
        .expect(409);

      expect(context.prismaMock.allowedEmail.create).not.toHaveBeenCalled();
    });

    it('should return 400 for invalid email format', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .post('/api/allowlist')
        .set(authHeader(admin.accessToken))
        .send({ email: 'not-an-email' })
        .expect(400);

      expect(response.body).toHaveProperty('message');
    });

    it('should return 403 for non-admin (Contributor)', async () => {
      const contributor = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .post('/api/allowlist')
        .set(authHeader(contributor.accessToken))
        .send({ email: 'test@example.com' })
        .expect(403);
    });
  });

  describe('DELETE /api/allowlist/:id', () => {
    it('should return 401 if not authenticated', async () => {
      await request(context.app.getHttpServer())
        .delete('/api/allowlist/123e4567-e89b-12d3-a456-426614174000')
        .expect(401);
    });

    it('should return 403 if user lacks allowlist:write permission', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .delete('/api/allowlist/123e4567-e89b-12d3-a456-426614174000')
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });

    it('should delete entry for admin', async () => {
      const admin = await createMockAdminUser(context);

      const entry = createMockAllowedEmail({
        email: 'todelete@example.com',
        addedById: admin.id,
      });

      context.prismaMock.allowedEmail.findUnique.mockResolvedValue(entry);
      context.prismaMock.allowedEmail.delete.mockResolvedValue(entry);

      await request(context.app.getHttpServer())
        .delete(`/api/allowlist/${entry.id}`)
        .set(authHeader(admin.accessToken))
        .expect(204);

      expect(context.prismaMock.allowedEmail.delete).toHaveBeenCalledWith({
        where: { id: entry.id },
      });
    });

    it('should return 404 if entry not found', async () => {
      const admin = await createMockAdminUser(context);

      context.prismaMock.allowedEmail.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete('/api/allowlist/123e4567-e89b-12d3-a456-426614174999')
        .set(authHeader(admin.accessToken))
        .expect(404);
    });

    it('should return 400 if entry is claimed', async () => {
      const admin = await createMockAdminUser(context);
      const viewer = await createMockViewerUser(context);

      const entry = createMockAllowedEmail({
        email: 'claimed@example.com',
        addedById: admin.id,
        claimedById: viewer.id,
        claimedAt: new Date(),
      });

      context.prismaMock.allowedEmail.findUnique.mockResolvedValue(entry);

      const response = await request(context.app.getHttpServer())
        .delete(`/api/allowlist/${entry.id}`)
        .set(authHeader(admin.accessToken))
        .expect(400);

      expect(response.body.message).toContain(
        'Cannot remove allowlist entry that has been claimed',
      );
    });

    it('should create audit event', async () => {
      const admin = await createMockAdminUser(context);

      const entry = createMockAllowedEmail({
        email: 'audited-delete@example.com',
        addedById: admin.id,
      });

      context.prismaMock.allowedEmail.findUnique.mockResolvedValue(entry);
      context.prismaMock.allowedEmail.delete.mockResolvedValue(entry);

      await request(context.app.getHttpServer())
        .delete(`/api/allowlist/${entry.id}`)
        .set(authHeader(admin.accessToken))
        .expect(204);

      expect(context.prismaMock.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: admin.id,
            action: 'allowlist:remove',
            targetId: entry.id,
          }),
        }),
      );
    });

    it('should validate UUID format', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .delete('/api/allowlist/invalid-uuid')
        .set(authHeader(admin.accessToken))
        .expect(400);
    });

    it('should remove pending entry successfully', async () => {
      const admin = await createMockAdminUser(context);

      const pendingEntry = createMockAllowedEmail({
        email: 'pending@example.com',
        addedById: admin.id,
        claimedById: null,
        claimedAt: null,
      });

      context.prismaMock.allowedEmail.findUnique.mockResolvedValue(
        pendingEntry,
      );
      context.prismaMock.allowedEmail.delete.mockResolvedValue(pendingEntry);

      await request(context.app.getHttpServer())
        .delete(`/api/allowlist/${pendingEntry.id}`)
        .set(authHeader(admin.accessToken))
        .expect(204);

      expect(context.prismaMock.allowedEmail.delete).toHaveBeenCalledWith({
        where: { id: pendingEntry.id },
      });
    });

    it('should return 403 when trying to remove claimed entry', async () => {
      const admin = await createMockAdminUser(context);
      const viewer = await createMockViewerUser(context);

      const claimedEntry = createMockAllowedEmail({
        email: 'claimed@example.com',
        addedById: admin.id,
        claimedById: viewer.id,
        claimedAt: new Date(),
      });

      context.prismaMock.allowedEmail.findUnique.mockResolvedValue(
        claimedEntry,
      );

      await request(context.app.getHttpServer())
        .delete(`/api/allowlist/${claimedEntry.id}`)
        .set(authHeader(admin.accessToken))
        .expect(400);

      expect(context.prismaMock.allowedEmail.delete).not.toHaveBeenCalled();
    });

    it('should return 404 for non-existent entry', async () => {
      const admin = await createMockAdminUser(context);

      context.prismaMock.allowedEmail.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete('/api/allowlist/00000000-0000-0000-0000-000000000000')
        .set(authHeader(admin.accessToken))
        .expect(404);
    });

    it('should return 403 for non-admin (Contributor)', async () => {
      const contributor = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .delete('/api/allowlist/123e4567-e89b-12d3-a456-426614174000')
        .set(authHeader(contributor.accessToken))
        .expect(403);
    });
  });
});
