import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock, mockPrismaTransaction } from '../mocks/prisma.mock';
import { setupBaseMocks, setupMockUser } from '../fixtures/mock-setup.helper';
import {
  createMockAdminUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import { prismaMock } from '../mocks/prisma.mock';
import { mockRoles } from '../fixtures/test-data.factory';

describe('Users Self-Prevention Guards (Integration)', () => {
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
    mockPrismaTransaction();
  });

  describe.skip('PATCH /api/users/:id - Self-Deactivation Prevention', () => {
    describe('when admin tries to deactivate their own account', () => {
      it('should return 403 Forbidden', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');

        const response = await request(context.app.getHttpServer())
          .patch(`/api/users/${admin.id}`)
          .set(authHeader(admin.accessToken))
          .send({ isActive: false })
          .expect(403);

        expect(response.body).toHaveProperty('code');
        expect(response.body.code).toBe('FORBIDDEN');
        expect(response.body.message).toBe('Cannot deactivate your own account');
      });

      it('should not modify the user in database', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');

        await request(context.app.getHttpServer())
          .patch(`/api/users/${admin.id}`)
          .set(authHeader(admin.accessToken))
          .send({ isActive: false })
          .expect(403);

        // Verify database update was never called
        expect(prismaMock.user.update).not.toHaveBeenCalled();
      });
    });

    describe('when admin deactivates another user', () => {
      it('should succeed and return 200', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');
        const otherUser = setupMockUser({
          email: 'other@example.com',
          roleName: 'viewer',
          isActive: true,
        });

        const deactivatedUser = {
          id: otherUser.id,
          email: otherUser.email,
          displayName: null,
          providerDisplayName: 'Other User',
          profileImageUrl: null,
          providerProfileImageUrl: 'https://example.com/photo.jpg',
          isActive: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          userRoles: [
            {
              userId: otherUser.id,
              roleId: mockRoles.viewer.id,
              role: mockRoles.viewer,
            },
          ],
        };

        prismaMock.user.update.mockResolvedValue(deactivatedUser as any);
        prismaMock.auditEvent.create.mockResolvedValue({} as any);

        const response = await request(context.app.getHttpServer())
          .patch(`/api/users/${otherUser.id}`)
          .set(authHeader(admin.accessToken))
          .send({ isActive: false })
          .expect(200);

        expect(response.body.data.isActive).toBe(false);
        expect(prismaMock.user.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: otherUser.id },
            data: expect.objectContaining({
              isActive: false,
            }),
          })
        );
      });

      it('should create audit event for deactivation', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');
        const otherUser = setupMockUser({
          email: 'other@example.com',
          roleName: 'viewer',
        });

        const deactivatedUser = {
          id: otherUser.id,
          email: otherUser.email,
          isActive: false,
          userRoles: [{ role: mockRoles.viewer }],
        };

        prismaMock.user.update.mockResolvedValue(deactivatedUser as any);
        prismaMock.auditEvent.create.mockResolvedValue({} as any);

        await request(context.app.getHttpServer())
          .patch(`/api/users/${otherUser.id}`)
          .set(authHeader(admin.accessToken))
          .send({ isActive: false })
          .expect(200);

        expect(prismaMock.auditEvent.create).toHaveBeenCalledWith({
          data: {
            actorUserId: admin.id,
            action: 'user:update',
            targetType: 'user',
            targetId: otherUser.id,
            meta: {
              changes: { isActive: false },
            },
          },
        });
      });
    });

    describe('when admin updates their own non-dangerous fields', () => {
      it('should succeed updating displayName', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');

        const updatedAdmin = {
          id: admin.id,
          email: admin.email,
          displayName: 'New Display Name',
          providerDisplayName: 'Admin User',
          profileImageUrl: null,
          providerProfileImageUrl: 'https://example.com/photo.jpg',
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          userRoles: [
            {
              userId: admin.id,
              roleId: mockRoles.admin.id,
              role: mockRoles.admin,
            },
          ],
        };

        prismaMock.user.update.mockResolvedValue(updatedAdmin as any);
        prismaMock.auditEvent.create.mockResolvedValue({} as any);

        const response = await request(context.app.getHttpServer())
          .patch(`/api/users/${admin.id}`)
          .set(authHeader(admin.accessToken))
          .send({ displayName: 'New Display Name' })
          .expect(200);

        expect(response.body.data.displayName).toBe('New Display Name');
        expect(response.body.data.isActive).toBe(true);
      });

      it('should succeed when isActive is explicitly true', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');

        const updatedAdmin = {
          id: admin.id,
          email: admin.email,
          isActive: true,
          userRoles: [{ role: mockRoles.admin }],
        };

        prismaMock.user.update.mockResolvedValue(updatedAdmin as any);
        prismaMock.auditEvent.create.mockResolvedValue({} as any);

        const response = await request(context.app.getHttpServer())
          .patch(`/api/users/${admin.id}`)
          .set(authHeader(admin.accessToken))
          .send({ displayName: 'Test', isActive: true })
          .expect(200);

        expect(response.body.data.isActive).toBe(true);
      });
    });
  });

  describe.skip('PUT /api/users/:id/roles - Self-Role-Removal Prevention', () => {
    describe('when admin tries to remove their own admin role', () => {
      it('should return 403 when removing admin role', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');

        // No need to mock additional database calls - the guard check happens first

        const response = await request(context.app.getHttpServer())
          .put(`/api/users/${admin.id}/roles`)
          .set(authHeader(admin.accessToken))
          .send({ roleNames: ['viewer'] })
          .expect(403);

        expect(response.body).toHaveProperty('code');
        expect(response.body.code).toBe('FORBIDDEN');
        expect(response.body.message).toBe('Cannot remove admin role from yourself');
      });

      it('should return 403 when setting empty role list', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');

        const response = await request(context.app.getHttpServer())
          .put(`/api/users/${admin.id}/roles`)
          .set(authHeader(admin.accessToken))
          .send({ roleNames: [] })
          .expect(403);

        expect(response.body.message).toBe('Cannot remove admin role from yourself');
      });

      it('should not modify roles in database', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');

        await request(context.app.getHttpServer())
          .put(`/api/users/${admin.id}/roles`)
          .set(authHeader(admin.accessToken))
          .send({ roleNames: ['contributor'] })
          .expect(403);

        // Verify transaction was never started
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
      });
    });

    describe('when admin adds roles to themselves while keeping admin', () => {
      it('should succeed adding contributor role', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');

        // Get the admin user from the mock registry
        const adminUser = {
          id: admin.id,
          email: admin.email,
          isActive: true,
          userRoles: [
            {
              userId: admin.id,
              roleId: mockRoles.admin.id,
              role: {
                ...mockRoles.admin,
                rolePermissions: [],
              },
            },
          ],
        };

        // Mock the updated user with both roles
        const updatedAdmin = {
          id: admin.id,
          email: admin.email,
          isActive: true,
          userRoles: [
            {
              userId: admin.id,
              roleId: mockRoles.admin.id,
              role: {
                ...mockRoles.admin,
                rolePermissions: [],
              },
            },
            {
              userId: admin.id,
              roleId: mockRoles.contributor.id,
              role: {
                ...mockRoles.contributor,
                rolePermissions: [],
              },
            },
          ],
          identities: [],
        };

        // Setup mocks in proper order
        prismaMock.user.findUnique
          .mockResolvedValueOnce(adminUser as any) // First call in updateUserRoles validation
          .mockResolvedValueOnce(updatedAdmin as any); // Second call in getUserById

        prismaMock.role.findMany.mockResolvedValue([
          mockRoles.admin,
          mockRoles.contributor,
        ] as any);

        prismaMock.auditEvent.create.mockResolvedValue({} as any);

        const response = await request(context.app.getHttpServer())
          .put(`/api/users/${admin.id}/roles`)
          .set(authHeader(admin.accessToken))
          .send({ roleNames: ['admin', 'contributor'] })
          .expect(200);

        expect(response.body.data.roles).toContain('admin');
        expect(response.body.data.roles).toContain('contributor');
      });

      it('should succeed when admin is first in role list', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');

        const adminUser = {
          id: admin.id,
          email: admin.email,
          isActive: true,
          userRoles: [
            {
              userId: admin.id,
              roleId: mockRoles.admin.id,
              role: { ...mockRoles.admin, rolePermissions: [] },
            },
          ],
        };

        const updatedAdmin = {
          id: admin.id,
          email: admin.email,
          isActive: true,
          userRoles: [
            { userId: admin.id, roleId: mockRoles.admin.id, role: { ...mockRoles.admin, rolePermissions: [] } },
            { userId: admin.id, roleId: mockRoles.viewer.id, role: { ...mockRoles.viewer, rolePermissions: [] } },
          ],
          identities: [],
        };

        prismaMock.user.findUnique
          .mockResolvedValueOnce(adminUser as any)
          .mockResolvedValueOnce(updatedAdmin as any);

        prismaMock.role.findMany.mockResolvedValue([
          mockRoles.admin,
          mockRoles.viewer,
        ] as any);

        prismaMock.auditEvent.create.mockResolvedValue({} as any);

        const response = await request(context.app.getHttpServer())
          .put(`/api/users/${admin.id}/roles`)
          .set(authHeader(admin.accessToken))
          .send({ roleNames: ['admin', 'viewer'] })
          .expect(200);

        expect(response.body.data.roles).toContain('admin');
      });

      it('should succeed when admin is last in role list', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');

        const adminUser = {
          id: admin.id,
          email: admin.email,
          isActive: true,
          userRoles: [
            {
              userId: admin.id,
              roleId: mockRoles.admin.id,
              role: { ...mockRoles.admin, rolePermissions: [] },
            },
          ],
        };

        const updatedAdmin = {
          id: admin.id,
          email: admin.email,
          isActive: true,
          userRoles: [
            { userId: admin.id, roleId: mockRoles.contributor.id, role: { ...mockRoles.contributor, rolePermissions: [] } },
            { userId: admin.id, roleId: mockRoles.admin.id, role: { ...mockRoles.admin, rolePermissions: [] } },
          ],
          identities: [],
        };

        prismaMock.user.findUnique
          .mockResolvedValueOnce(adminUser as any)
          .mockResolvedValueOnce(updatedAdmin as any);

        prismaMock.role.findMany.mockResolvedValue([
          mockRoles.contributor,
          mockRoles.admin,
        ] as any);

        prismaMock.auditEvent.create.mockResolvedValue({} as any);

        const response = await request(context.app.getHttpServer())
          .put(`/api/users/${admin.id}/roles`)
          .set(authHeader(admin.accessToken))
          .send({ roleNames: ['contributor', 'admin'] })
          .expect(200);

        expect(response.body.data.roles).toContain('admin');
      });
    });

    describe('when admin removes admin role from another admin', () => {
      it('should succeed', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');
        const otherAdmin = setupMockUser({
          email: 'other-admin@example.com',
          roleName: 'admin',
        });

        const otherAdminUser = {
          id: otherAdmin.id,
          email: otherAdmin.email,
          isActive: true,
          userRoles: [
            {
              userId: otherAdmin.id,
              roleId: mockRoles.admin.id,
              role: { ...mockRoles.admin, rolePermissions: [] },
            },
          ],
        };

        const demotedUser = {
          id: otherAdmin.id,
          email: otherAdmin.email,
          isActive: true,
          userRoles: [
            {
              userId: otherAdmin.id,
              roleId: mockRoles.viewer.id,
              role: { ...mockRoles.viewer, rolePermissions: [] },
            },
          ],
          identities: [],
        };

        prismaMock.user.findUnique
          .mockResolvedValueOnce(otherAdminUser as any)
          .mockResolvedValueOnce(demotedUser as any);

        prismaMock.role.findMany.mockResolvedValue([mockRoles.viewer] as any);
        prismaMock.auditEvent.create.mockResolvedValue({} as any);

        const response = await request(context.app.getHttpServer())
          .put(`/api/users/${otherAdmin.id}/roles`)
          .set(authHeader(admin.accessToken))
          .send({ roleNames: ['viewer'] })
          .expect(200);

        expect(response.body.data.roles).toEqual(['viewer']);
        expect(response.body.data.roles).not.toContain('admin');
      });

      it('should create audit event for role change', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');
        const otherUser = setupMockUser({
          email: 'other@example.com',
          roleName: 'viewer',
        });

        const viewerUser = {
          id: otherUser.id,
          email: otherUser.email,
          isActive: true,
          userRoles: [
            {
              userId: otherUser.id,
              roleId: mockRoles.viewer.id,
              role: { ...mockRoles.viewer, rolePermissions: [] },
            },
          ],
        };

        const updatedUser = {
          id: otherUser.id,
          email: otherUser.email,
          isActive: true,
          userRoles: [{ userId: otherUser.id, roleId: mockRoles.contributor.id, role: { ...mockRoles.contributor, rolePermissions: [] } }],
          identities: [],
        };

        prismaMock.user.findUnique
          .mockResolvedValueOnce(viewerUser as any)
          .mockResolvedValueOnce(updatedUser as any);

        prismaMock.role.findMany.mockResolvedValue([mockRoles.contributor] as any);
        prismaMock.auditEvent.create.mockResolvedValue({} as any);

        await request(context.app.getHttpServer())
          .put(`/api/users/${otherUser.id}/roles`)
          .set(authHeader(admin.accessToken))
          .send({ roleNames: ['contributor'] })
          .expect(200);

        expect(prismaMock.auditEvent.create).toHaveBeenCalledWith({
          data: {
            actorUserId: admin.id,
            action: 'user:roles_update',
            targetType: 'user',
            targetId: otherUser.id,
            meta: {
              newRoles: ['contributor'],
            },
          },
        });
      });
    });

    describe('when admin changes roles for non-admin users', () => {
      it('should succeed promoting viewer to contributor', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');
        const viewer = setupMockUser({
          email: 'viewer@example.com',
          roleName: 'viewer',
        });

        const viewerUser = {
          id: viewer.id,
          email: viewer.email,
          isActive: true,
          userRoles: [
            {
              userId: viewer.id,
              roleId: mockRoles.viewer.id,
              role: { ...mockRoles.viewer, rolePermissions: [] },
            },
          ],
        };

        const promotedUser = {
          id: viewer.id,
          email: viewer.email,
          isActive: true,
          userRoles: [
            {
              userId: viewer.id,
              roleId: mockRoles.contributor.id,
              role: { ...mockRoles.contributor, rolePermissions: [] },
            },
          ],
          identities: [],
        };

        prismaMock.user.findUnique
          .mockResolvedValueOnce(viewerUser as any)
          .mockResolvedValueOnce(promotedUser as any);

        prismaMock.role.findMany.mockResolvedValue([mockRoles.contributor] as any);
        prismaMock.auditEvent.create.mockResolvedValue({} as any);

        const response = await request(context.app.getHttpServer())
          .put(`/api/users/${viewer.id}/roles`)
          .set(authHeader(admin.accessToken))
          .send({ roleNames: ['contributor'] })
          .expect(200);

        expect(response.body.data.roles).toEqual(['contributor']);
      });

      it('should succeed demoting contributor to viewer', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');
        const contributor = setupMockUser({
          email: 'contributor@example.com',
          roleName: 'contributor',
        });

        const contributorUser = {
          id: contributor.id,
          email: contributor.email,
          isActive: true,
          userRoles: [
            {
              userId: contributor.id,
              roleId: mockRoles.contributor.id,
              role: { ...mockRoles.contributor, rolePermissions: [] },
            },
          ],
        };

        const demotedUser = {
          id: contributor.id,
          email: contributor.email,
          isActive: true,
          userRoles: [
            {
              userId: contributor.id,
              roleId: mockRoles.viewer.id,
              role: { ...mockRoles.viewer, rolePermissions: [] },
            },
          ],
          identities: [],
        };

        prismaMock.user.findUnique
          .mockResolvedValueOnce(contributorUser as any)
          .mockResolvedValueOnce(demotedUser as any);

        prismaMock.role.findMany.mockResolvedValue([mockRoles.viewer] as any);
        prismaMock.auditEvent.create.mockResolvedValue({} as any);

        const response = await request(context.app.getHttpServer())
          .put(`/api/users/${contributor.id}/roles`)
          .set(authHeader(admin.accessToken))
          .send({ roleNames: ['viewer'] })
          .expect(200);

        expect(response.body.data.roles).toEqual(['viewer']);
      });
    });

    describe('error handling', () => {
      it('should return 404 when user not found', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');

        prismaMock.user.findUnique.mockResolvedValue(null);

        const response = await request(context.app.getHttpServer())
          .put('/api/users/123e4567-e89b-12d3-a456-426614174000/roles')
          .set(authHeader(admin.accessToken))
          .send({ roleNames: ['viewer'] })
          .expect(404);

        expect(response.body.code).toBe('NOT_FOUND');
      });

      it('should return 400 when role is invalid', async () => {
        const admin = await createMockAdminUser(context, 'admin@example.com');
        const otherUser = setupMockUser({
          email: 'other@example.com',
          roleName: 'viewer',
        });

        const viewerUser = {
          id: otherUser.id,
          email: otherUser.email,
          isActive: true,
          userRoles: [
            {
              userId: otherUser.id,
              roleId: mockRoles.viewer.id,
              role: { ...mockRoles.viewer, rolePermissions: [] },
            },
          ],
        };

        prismaMock.user.findUnique.mockResolvedValue(viewerUser as any);
        prismaMock.role.findMany.mockResolvedValue([]); // No roles found

        const response = await request(context.app.getHttpServer())
          .put(`/api/users/${otherUser.id}/roles`)
          .set(authHeader(admin.accessToken))
          .send({ roleNames: ['invalid-role'] })
          .expect(400);

        expect(response.body.code).toBe('BAD_REQUEST');
        expect(response.body.message).toContain('Invalid roles');
      });
    });
  });
});
