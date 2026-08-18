import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserRolesDto } from './dto/update-user-roles.dto';
import { ROLES } from '../common/constants/roles.constants';

describe('UsersService', () => {
  let service: UsersService;
  let mockPrisma: MockPrismaService;

  const mockAdminUser = {
    id: 'admin-user-id',
    email: 'admin@example.com',
    displayName: 'Admin User',
    providerDisplayName: 'Admin from Provider',
    profileImageUrl: null,
    providerProfileImageUrl: 'https://example.com/admin.jpg',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    userRoles: [
      {
        userId: 'admin-user-id',
        roleId: 'admin-role-id',
        role: {
          id: 'admin-role-id',
          name: 'admin',
          description: 'Admin role',
        },
      },
    ],
  };

  const mockOtherUser = {
    id: 'other-user-id',
    email: 'other@example.com',
    displayName: 'Other User',
    providerDisplayName: 'Other from Provider',
    profileImageUrl: null,
    providerProfileImageUrl: 'https://example.com/other.jpg',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    userRoles: [
      {
        userId: 'other-user-id',
        roleId: 'viewer-role-id',
        role: {
          id: 'viewer-role-id',
          name: 'viewer',
          description: 'Viewer role',
        },
      },
    ],
  };

  const mockRoles = {
    admin: {
      id: 'admin-role-id',
      name: 'admin',
      description: 'Admin role',
    },
    contributor: {
      id: 'contributor-role-id',
      name: 'contributor',
      description: 'Contributor role',
    },
    viewer: {
      id: 'viewer-role-id',
      name: 'viewer',
      description: 'Viewer role',
    },
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Self-Prevention: updateUser', () => {
    describe('when admin tries to deactivate their own account', () => {
      it('should throw ForbiddenException', async () => {
        const dto: UpdateUserDto = {
          isActive: false,
        };

        await expect(
          service.updateUser(mockAdminUser.id, dto, mockAdminUser.id)
        ).rejects.toThrow(ForbiddenException);

        await expect(
          service.updateUser(mockAdminUser.id, dto, mockAdminUser.id)
        ).rejects.toThrow('Cannot deactivate your own account');

        // Should not reach database
        expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
      });
    });

    describe('when admin deactivates another user', () => {
      it('should succeed', async () => {
        const dto: UpdateUserDto = {
          isActive: false,
        };

        const deactivatedUser = {
          ...mockOtherUser,
          isActive: false,
        };

        mockPrisma.user.findUnique.mockResolvedValue(mockOtherUser as any);
        mockPrisma.user.update.mockResolvedValue(deactivatedUser as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.updateUser(
          mockOtherUser.id,
          dto,
          mockAdminUser.id
        );

        expect(result.isActive).toBe(false);
        expect(mockPrisma.user.update).toHaveBeenCalledWith({
          where: { id: mockOtherUser.id },
          data: {
            displayName: undefined,
            isActive: false,
          },
          include: {
            userRoles: {
              include: { role: true },
            },
          },
        });
      });
    });

    describe('when admin updates their own non-dangerous field', () => {
      it('should succeed updating displayName', async () => {
        const dto: UpdateUserDto = {
          displayName: 'New Display Name',
        };

        const updatedUser = {
          ...mockAdminUser,
          displayName: 'New Display Name',
        };

        mockPrisma.user.findUnique.mockResolvedValue(mockAdminUser as any);
        mockPrisma.user.update.mockResolvedValue(updatedUser as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.updateUser(
          mockAdminUser.id,
          dto,
          mockAdminUser.id
        );

        expect(result.displayName).toBe('New Display Name');
        expect(mockPrisma.user.update).toHaveBeenCalledWith({
          where: { id: mockAdminUser.id },
          data: {
            displayName: 'New Display Name',
            isActive: undefined,
          },
          include: {
            userRoles: {
              include: { role: true },
            },
          },
        });
      });

      it('should succeed when isActive is not set', async () => {
        const dto: UpdateUserDto = {
          displayName: 'Another Name',
        };

        const updatedUser = {
          ...mockAdminUser,
          displayName: 'Another Name',
        };

        mockPrisma.user.findUnique.mockResolvedValue(mockAdminUser as any);
        mockPrisma.user.update.mockResolvedValue(updatedUser as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await expect(
          service.updateUser(mockAdminUser.id, dto, mockAdminUser.id)
        ).resolves.toBeTruthy();
      });

      it('should succeed when isActive is explicitly true', async () => {
        const dto: UpdateUserDto = {
          displayName: 'Test Name',
          isActive: true,
        };

        const updatedUser = {
          ...mockAdminUser,
          displayName: 'Test Name',
        };

        mockPrisma.user.findUnique.mockResolvedValue(mockAdminUser as any);
        mockPrisma.user.update.mockResolvedValue(updatedUser as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await expect(
          service.updateUser(mockAdminUser.id, dto, mockAdminUser.id)
        ).resolves.toBeTruthy();
      });
    });

    describe('error handling', () => {
      it('should throw NotFoundException when user does not exist', async () => {
        const dto: UpdateUserDto = {
          displayName: 'New Name',
        };

        mockPrisma.user.findUnique.mockResolvedValue(null);

        await expect(
          service.updateUser('non-existent-id', dto, mockAdminUser.id)
        ).rejects.toThrow(NotFoundException);

        await expect(
          service.updateUser('non-existent-id', dto, mockAdminUser.id)
        ).rejects.toThrow('User with ID non-existent-id not found');
      });
    });
  });

  describe('listUsers', () => {
    describe('when called with default parameters', () => {
      it('should return paginated users with correct metadata', async () => {
        const mockUsers = [mockAdminUser, mockOtherUser];

        mockPrisma.user.findMany.mockResolvedValue(mockUsers as any);
        mockPrisma.user.count.mockResolvedValue(2);

        const result = await service.listUsers({
          page: 1,
          pageSize: 20,
          sortBy: 'createdAt',
          sortOrder: 'desc',
        });

        expect(result.items).toHaveLength(2);
        expect(result.total).toBe(2);
        expect(result.page).toBe(1);
        expect(result.pageSize).toBe(20);
        expect(result.totalPages).toBe(1);
        expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
          where: {},
          skip: 0,
          take: 20,
          orderBy: { createdAt: 'desc' },
          include: {
            userRoles: {
              include: { role: true },
            },
          },
        });
      });
    });

    describe('when filtering by role', () => {
      it('should filter users by role', async () => {
        const mockUsers = [mockAdminUser];

        mockPrisma.user.findMany.mockResolvedValue(mockUsers as any);
        mockPrisma.user.count.mockResolvedValue(1);

        const result = await service.listUsers({
          page: 1,
          pageSize: 20,
          role: 'admin',
          sortBy: 'createdAt',
          sortOrder: 'desc',
        });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].roles).toContain('admin');
        expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              userRoles: {
                some: {
                  role: { name: 'admin' },
                },
              },
            },
          }),
        );
      });
    });

    describe('when filtering by isActive status', () => {
      it('should filter active users', async () => {
        const mockUsers = [mockAdminUser, mockOtherUser];

        mockPrisma.user.findMany.mockResolvedValue(mockUsers as any);
        mockPrisma.user.count.mockResolvedValue(2);

        await service.listUsers({
          page: 1,
          pageSize: 20,
          isActive: true,
          sortBy: 'createdAt',
          sortOrder: 'desc',
        });

        expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { isActive: true },
          }),
        );
      });

      it('should filter inactive users', async () => {
        const inactiveUser = { ...mockOtherUser, isActive: false };

        mockPrisma.user.findMany.mockResolvedValue([inactiveUser] as any);
        mockPrisma.user.count.mockResolvedValue(1);

        const result = await service.listUsers({
          page: 1,
          pageSize: 20,
          isActive: false,
          sortBy: 'createdAt',
          sortOrder: 'desc',
        });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].isActive).toBe(false);
        expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { isActive: false },
          }),
        );
      });
    });

    describe('when searching by email or displayName', () => {
      it('should search by email', async () => {
        const mockUsers = [mockAdminUser];

        mockPrisma.user.findMany.mockResolvedValue(mockUsers as any);
        mockPrisma.user.count.mockResolvedValue(1);

        await service.listUsers({
          page: 1,
          pageSize: 20,
          search: 'admin',
          sortBy: 'createdAt',
          sortOrder: 'desc',
        });

        expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              OR: [
                { email: { contains: 'admin', mode: 'insensitive' } },
                { displayName: { contains: 'admin', mode: 'insensitive' } },
                { providerDisplayName: { contains: 'admin', mode: 'insensitive' } },
              ],
            },
          }),
        );
      });

      it('should search by displayName', async () => {
        const userWithDisplayName = {
          ...mockOtherUser,
          displayName: 'Custom Name',
        };

        mockPrisma.user.findMany.mockResolvedValue([userWithDisplayName] as any);
        mockPrisma.user.count.mockResolvedValue(1);

        const result = await service.listUsers({
          page: 1,
          pageSize: 20,
          search: 'Custom',
          sortBy: 'createdAt',
          sortOrder: 'desc',
        });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].displayName).toBe('Custom Name');
      });
    });

    describe('when sorting by different fields', () => {
      it('should sort by email ascending', async () => {
        const mockUsers = [mockAdminUser, mockOtherUser];

        mockPrisma.user.findMany.mockResolvedValue(mockUsers as any);
        mockPrisma.user.count.mockResolvedValue(2);

        await service.listUsers({
          page: 1,
          pageSize: 20,
          sortBy: 'email',
          sortOrder: 'asc',
        });

        expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            orderBy: { email: 'asc' },
          }),
        );
      });

      it('should sort by displayName descending', async () => {
        const mockUsers = [mockAdminUser, mockOtherUser];

        mockPrisma.user.findMany.mockResolvedValue(mockUsers as any);
        mockPrisma.user.count.mockResolvedValue(2);

        await service.listUsers({
          page: 1,
          pageSize: 20,
          sortBy: 'createdAt',
          sortOrder: 'desc',
        });

        expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            orderBy: { createdAt: 'desc' },
          }),
        );
      });

      it('should sort by updatedAt', async () => {
        const mockUsers = [mockAdminUser, mockOtherUser];

        mockPrisma.user.findMany.mockResolvedValue(mockUsers as any);
        mockPrisma.user.count.mockResolvedValue(2);

        await service.listUsers({
          page: 1,
          pageSize: 20,
          sortBy: 'updatedAt',
          sortOrder: 'asc',
        });

        expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            orderBy: { updatedAt: 'asc' },
          }),
        );
      });
    });

    describe('pagination', () => {
      it('should handle pagination correctly for page 2', async () => {
        const mockUsers = [mockAdminUser];

        mockPrisma.user.findMany.mockResolvedValue(mockUsers as any);
        mockPrisma.user.count.mockResolvedValue(25);

        const result = await service.listUsers({
          page: 2,
          pageSize: 10,
          sortBy: 'createdAt',
          sortOrder: 'desc',
        });

        expect(result.page).toBe(2);
        expect(result.pageSize).toBe(10);
        expect(result.totalPages).toBe(3);
        expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            skip: 10,
            take: 10,
          }),
        );
      });

      it('should calculate totalPages correctly', async () => {
        mockPrisma.user.findMany.mockResolvedValue([] as any);
        mockPrisma.user.count.mockResolvedValue(47);

        const result = await service.listUsers({
          page: 1,
          pageSize: 20,
          sortBy: 'createdAt',
          sortOrder: 'desc',
        });

        expect(result.totalPages).toBe(3); // Math.ceil(47 / 20)
      });
    });
  });

  describe('getUserById', () => {
    describe('when user exists', () => {
      it('should return user with roles and identities', async () => {
        const mockUserWithIdentities = {
          ...mockAdminUser,
          identities: [
            {
              provider: 'google',
              providerEmail: 'admin@example.com',
              createdAt: new Date(),
            },
          ],
        };

        mockPrisma.user.findUnique.mockResolvedValue(mockUserWithIdentities as any);

        const result = await service.getUserById(mockAdminUser.id);

        expect(result.id).toBe(mockAdminUser.id);
        expect(result.email).toBe(mockAdminUser.email);
        expect(result.roles).toContain('admin');
        expect(result.identities).toHaveLength(1);
        expect(result.identities[0].provider).toBe('google');
        expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
          where: { id: mockAdminUser.id },
          include: {
            userRoles: {
              include: { role: true },
            },
            identities: {
              select: {
                provider: true,
                providerEmail: true,
                createdAt: true,
              },
            },
          },
        });
      });
    });

    describe('when user does not exist', () => {
      it('should throw NotFoundException', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(null);

        await expect(
          service.getUserById('non-existent-id')
        ).rejects.toThrow(NotFoundException);

        await expect(
          service.getUserById('non-existent-id')
        ).rejects.toThrow('User with ID non-existent-id not found');
      });
    });
  });

  describe('Self-Prevention: updateUserRoles', () => {
    describe('when admin tries to remove their own admin role', () => {
      it('should throw ForbiddenException when admin role not in new roles', async () => {
        const dto: UpdateUserRolesDto = {
          roleNames: ['viewer'], // Admin role removed
        };

        await expect(
          service.updateUserRoles(mockAdminUser.id, dto, mockAdminUser.id)
        ).rejects.toThrow(ForbiddenException);

        await expect(
          service.updateUserRoles(mockAdminUser.id, dto, mockAdminUser.id)
        ).rejects.toThrow('Cannot remove admin role from yourself');

        // Should not reach database
        expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      });

      it('should throw ForbiddenException when role list is empty', async () => {
        const dto: UpdateUserRolesDto = {
          roleNames: [], // All roles removed including admin
        };

        await expect(
          service.updateUserRoles(mockAdminUser.id, dto, mockAdminUser.id)
        ).rejects.toThrow(ForbiddenException);

        await expect(
          service.updateUserRoles(mockAdminUser.id, dto, mockAdminUser.id)
        ).rejects.toThrow('Cannot remove admin role from yourself');
      });
    });

    describe('when admin adds roles to themselves', () => {
      it('should succeed adding contributor role while keeping admin', async () => {
        const dto: UpdateUserRolesDto = {
          roleNames: ['admin', 'contributor'], // Admin role still present
        };

        const roles = [mockRoles.admin, mockRoles.contributor];

        // Mock getUserById for the return value - needs to be set up with proper chaining
        const updatedUser = {
          ...mockAdminUser,
          userRoles: [
            mockAdminUser.userRoles[0],
            {
              userId: mockAdminUser.id,
              roleId: 'contributor-role-id',
              role: mockRoles.contributor,
            },
          ],
          identities: [],
        };

        mockPrisma.user.findUnique
          .mockResolvedValueOnce(mockAdminUser as any) // First call for validation
          .mockResolvedValueOnce(updatedUser as any); // Second call in getUserById
        mockPrisma.role.findMany.mockResolvedValue(roles as any);
        mockPrisma.$transaction.mockImplementation(async (callback) => {
          return callback(mockPrisma);
        });
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.updateUserRoles(
          mockAdminUser.id,
          dto,
          mockAdminUser.id
        );

        expect(mockPrisma.$transaction).toHaveBeenCalled();
        expect(result.roles).toContain('admin');
        expect(result.roles).toContain('contributor');
      });
    });

    describe('when admin removes admin role from another user', () => {
      it('should succeed', async () => {
        const otherAdminUser = {
          ...mockOtherUser,
          userRoles: [
            {
              userId: mockOtherUser.id,
              roleId: 'admin-role-id',
              role: mockRoles.admin,
            },
          ],
        };

        const dto: UpdateUserRolesDto = {
          roleNames: ['viewer'], // Removing admin role from other user
        };

        // Mock getUserById for the return value
        const updatedOtherUser = {
          ...otherAdminUser,
          userRoles: [
            {
              userId: otherAdminUser.id,
              roleId: 'viewer-role-id',
              role: mockRoles.viewer,
            },
          ],
          identities: [],
        };

        mockPrisma.user.findUnique
          .mockResolvedValueOnce(otherAdminUser as any) // First call for validation
          .mockResolvedValueOnce(updatedOtherUser as any); // Second call in getUserById
        mockPrisma.role.findMany.mockResolvedValue([mockRoles.viewer] as any);
        mockPrisma.$transaction.mockImplementation(async (callback) => {
          return callback(mockPrisma);
        });
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.updateUserRoles(
          mockOtherUser.id,
          dto,
          mockAdminUser.id
        );

        expect(mockPrisma.$transaction).toHaveBeenCalled();
        expect(result.roles).toEqual(['viewer']);
        expect(result.roles).not.toContain('admin');
      });
    });

    describe('when admin changes roles for non-admin user', () => {
      it('should succeed promoting viewer to contributor', async () => {
        const dto: UpdateUserRolesDto = {
          roleNames: ['contributor'],
        };

        // Mock getUserById for the return value
        const updatedUser = {
          ...mockOtherUser,
          userRoles: [
            {
              userId: mockOtherUser.id,
              roleId: 'contributor-role-id',
              role: mockRoles.contributor,
            },
          ],
          identities: [],
        };

        mockPrisma.user.findUnique
          .mockResolvedValueOnce(mockOtherUser as any) // First call for validation
          .mockResolvedValueOnce(updatedUser as any); // Second call in getUserById
        mockPrisma.role.findMany.mockResolvedValue([mockRoles.contributor] as any);
        mockPrisma.$transaction.mockImplementation(async (callback) => {
          return callback(mockPrisma);
        });
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.updateUserRoles(
          mockOtherUser.id,
          dto,
          mockAdminUser.id
        );

        expect(result.roles).toEqual(['contributor']);
      });
    });

    describe('error handling', () => {
      it('should throw NotFoundException when user does not exist', async () => {
        const dto: UpdateUserRolesDto = {
          roleNames: ['viewer'],
        };

        mockPrisma.user.findUnique.mockResolvedValue(null);

        await expect(
          service.updateUserRoles('non-existent-id', dto, mockAdminUser.id)
        ).rejects.toThrow(NotFoundException);

        await expect(
          service.updateUserRoles('non-existent-id', dto, mockAdminUser.id)
        ).rejects.toThrow('User with ID non-existent-id not found');
      });

      it('should throw BadRequestException when role does not exist', async () => {
        const dto: UpdateUserRolesDto = {
          roleNames: ['invalid-role'],
        };

        mockPrisma.user.findUnique.mockResolvedValue(mockOtherUser as any);
        mockPrisma.role.findMany.mockResolvedValue([]); // No roles found

        await expect(
          service.updateUserRoles(mockOtherUser.id, dto, mockAdminUser.id)
        ).rejects.toThrow(BadRequestException);

        await expect(
          service.updateUserRoles(mockOtherUser.id, dto, mockAdminUser.id)
        ).rejects.toThrow('Invalid roles: invalid-role');
      });

      it('should throw BadRequestException when some roles are invalid', async () => {
        const dto: UpdateUserRolesDto = {
          roleNames: ['admin', 'invalid-role', 'another-invalid'],
        };

        mockPrisma.user.findUnique.mockResolvedValue(mockOtherUser as any);
        mockPrisma.role.findMany.mockResolvedValue([mockRoles.admin] as any);

        await expect(
          service.updateUserRoles(mockOtherUser.id, dto, mockAdminUser.id)
        ).rejects.toThrow(BadRequestException);

        await expect(
          service.updateUserRoles(mockOtherUser.id, dto, mockAdminUser.id)
        ).rejects.toThrow('Invalid roles: invalid-role, another-invalid');
      });
    });
  });
});
