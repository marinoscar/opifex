import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AdminBootstrapService } from './admin-bootstrap.service';
import { PrismaService } from '../../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

describe('AdminBootstrapService', () => {
  let service: AdminBootstrapService;
  let prismaService: MockPrismaService;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    // Create mock Prisma service
    prismaService = createMockPrismaService();

    // Mock ConfigService
    const mockConfigService = {
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminBootstrapService,
        { provide: PrismaService, useValue: prismaService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<AdminBootstrapService>(AdminBootstrapService);
    configService = module.get(ConfigService) as jest.Mocked<ConfigService>;

    // Mock logger to avoid console output during tests
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('onModuleInit', () => {
    it('should skip in production environment', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'NODE_ENV') return 'production';
        return undefined;
      });

      await service.onModuleInit();

      expect(Logger.prototype.log).toHaveBeenCalledWith(
        'Admin bootstrap disabled in production'
      );
    });

    it('should run in development environment', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'NODE_ENV') return 'development';
        if (key === 'INITIAL_ADMIN_EMAIL') return 'admin@example.com';
        return undefined;
      });

      await service.onModuleInit();

      expect(Logger.prototype.log).toHaveBeenCalledWith(
        'Admin bootstrap configured for: admin@example.com'
      );
    });

    it('should warn when INITIAL_ADMIN_EMAIL not set', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'NODE_ENV') return 'development';
        if (key === 'INITIAL_ADMIN_EMAIL') return undefined;
        return undefined;
      });

      await service.onModuleInit();

      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        'INITIAL_ADMIN_EMAIL not set - no admin will be auto-assigned'
      );
    });

    it('should run in test environment', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'NODE_ENV') return 'test';
        if (key === 'INITIAL_ADMIN_EMAIL') return 'admin@test.com';
        return undefined;
      });

      await service.onModuleInit();

      expect(Logger.prototype.log).toHaveBeenCalledWith(
        'Admin bootstrap configured for: admin@test.com'
      );
    });
  });

  describe('shouldGrantAdminRole', () => {
    it('should grant admin role to INITIAL_ADMIN_EMAIL when no admins exist', async () => {
      const adminEmail = 'admin@example.com';
      configService.get.mockReturnValue(adminEmail);

      prismaService.role.findUnique.mockResolvedValue({
        id: 'admin-role-id',
        name: 'admin',
        description: 'Admin role',
        userRoles: [], // No existing admins
      } as any);

      const result = await service.shouldGrantAdminRole(adminEmail);

      expect(result).toBe(true);
      expect(prismaService.role.findUnique).toHaveBeenCalledWith({
        where: { name: 'admin' },
        include: {
          userRoles: {
            include: { user: true },
          },
        },
      });
    });

    it('should not grant admin role if user already has it', async () => {
      const adminEmail = 'admin@example.com';
      configService.get.mockReturnValue(adminEmail);

      prismaService.role.findUnique.mockResolvedValue({
        id: 'admin-role-id',
        name: 'admin',
        description: 'Admin role',
        userRoles: [
          {
            userId: 'existing-admin-id',
            roleId: 'admin-role-id',
            user: {
              id: 'existing-admin-id',
              email: adminEmail,
              isActive: true,
            },
          },
        ],
      } as any);

      const result = await service.shouldGrantAdminRole(adminEmail);

      expect(result).toBe(false);
    });

    it('should not grant admin role to non-matching emails', async () => {
      const initialAdminEmail = 'admin@example.com';
      const otherUserEmail = 'user@example.com';
      configService.get.mockReturnValue(initialAdminEmail);

      prismaService.role.findUnique.mockResolvedValue({
        id: 'admin-role-id',
        name: 'admin',
        description: 'Admin role',
        userRoles: [],
      } as any);

      const result = await service.shouldGrantAdminRole(otherUserEmail);

      expect(result).toBe(false);
    });

    it('should handle missing INITIAL_ADMIN_EMAIL config gracefully', async () => {
      configService.get.mockReturnValue(undefined);

      const result = await service.shouldGrantAdminRole('any@example.com');

      expect(result).toBe(false);
      expect(prismaService.role.findUnique).not.toHaveBeenCalled();
    });

    it('should return false when admin role does not exist', async () => {
      const adminEmail = 'admin@example.com';
      configService.get.mockReturnValue(adminEmail);

      prismaService.role.findUnique.mockResolvedValue(null);

      const result = await service.shouldGrantAdminRole(adminEmail);

      expect(result).toBe(false);
    });

    it('should ignore inactive admin users', async () => {
      const adminEmail = 'admin@example.com';
      configService.get.mockReturnValue(adminEmail);

      prismaService.role.findUnique.mockResolvedValue({
        id: 'admin-role-id',
        name: 'admin',
        description: 'Admin role',
        userRoles: [
          {
            userId: 'inactive-admin-id',
            roleId: 'admin-role-id',
            user: {
              id: 'inactive-admin-id',
              email: 'old-admin@example.com',
              isActive: false, // Inactive admin
            },
          },
        ],
      } as any);

      const result = await service.shouldGrantAdminRole(adminEmail);

      // Should grant admin since no active admins exist
      expect(result).toBe(true);
    });

    it('should handle case-sensitive email matching (exact match required)', async () => {
      const adminEmail = 'Admin@Example.com';
      configService.get.mockReturnValue('admin@example.com'); // lowercase in config

      prismaService.role.findUnique.mockResolvedValue({
        id: 'admin-role-id',
        name: 'admin',
        description: 'Admin role',
        userRoles: [],
      } as any);

      const result = await service.shouldGrantAdminRole(adminEmail);

      // Exact match is required (not case-insensitive)
      expect(result).toBe(false);
    });

    it('should not grant admin when other active admins exist', async () => {
      const adminEmail = 'new-admin@example.com';
      configService.get.mockReturnValue(adminEmail);

      prismaService.role.findUnique.mockResolvedValue({
        id: 'admin-role-id',
        name: 'admin',
        description: 'Admin role',
        userRoles: [
          {
            userId: 'existing-admin-id',
            roleId: 'admin-role-id',
            user: {
              id: 'existing-admin-id',
              email: 'existing@example.com',
              isActive: true,
            },
          },
        ],
      } as any);

      const result = await service.shouldGrantAdminRole(adminEmail);

      // Should not grant even though email matches, because other admin exists
      expect(result).toBe(false);
    });

    it('should log when granting admin role', async () => {
      const adminEmail = 'admin@example.com';
      configService.get.mockReturnValue(adminEmail);

      prismaService.role.findUnique.mockResolvedValue({
        id: 'admin-role-id',
        name: 'admin',
        description: 'Admin role',
        userRoles: [],
      } as any);

      await service.shouldGrantAdminRole(adminEmail);

      expect(Logger.prototype.log).toHaveBeenCalledWith(
        `Granting admin role to initial admin: ${adminEmail}`
      );
    });
  });

  describe('assignAdminRole', () => {
    it('should assign admin role to a user', async () => {
      const userId = 'user-123';
      const adminRoleId = 'admin-role-id';

      prismaService.role.findUnique.mockResolvedValue({
        id: adminRoleId,
        name: 'admin',
        description: 'Admin role',
      } as any);

      prismaService.userRole.upsert.mockResolvedValue({
        userId,
        roleId: adminRoleId,
      } as any);

      await service.assignAdminRole(userId);

      expect(prismaService.role.findUnique).toHaveBeenCalledWith({
        where: { name: 'admin' },
      });

      expect(prismaService.userRole.upsert).toHaveBeenCalledWith({
        where: {
          userId_roleId: {
            userId,
            roleId: adminRoleId,
          },
        },
        update: {},
        create: {
          userId,
          roleId: adminRoleId,
        },
      });
    });

    it('should throw error when admin role not found', async () => {
      const userId = 'user-123';

      prismaService.role.findUnique.mockResolvedValue(null);

      await expect(service.assignAdminRole(userId)).rejects.toThrow(
        'Admin role not found - run seeds first'
      );

      expect(prismaService.userRole.upsert).not.toHaveBeenCalled();
    });

    it('should log when admin role assigned', async () => {
      const userId = 'user-123';
      const adminRoleId = 'admin-role-id';

      prismaService.role.findUnique.mockResolvedValue({
        id: adminRoleId,
        name: 'admin',
        description: 'Admin role',
      } as any);

      prismaService.userRole.upsert.mockResolvedValue({
        userId,
        roleId: adminRoleId,
      } as any);

      await service.assignAdminRole(userId);

      expect(Logger.prototype.log).toHaveBeenCalledWith(
        `Admin role assigned to user: ${userId}`
      );
    });

    it('should use upsert to avoid duplicate role assignments', async () => {
      const userId = 'user-123';
      const adminRoleId = 'admin-role-id';

      prismaService.role.findUnique.mockResolvedValue({
        id: adminRoleId,
        name: 'admin',
        description: 'Admin role',
      } as any);

      prismaService.userRole.upsert.mockResolvedValue({
        userId,
        roleId: adminRoleId,
      } as any);

      // Call twice to verify upsert behavior
      await service.assignAdminRole(userId);
      await service.assignAdminRole(userId);

      expect(prismaService.userRole.upsert).toHaveBeenCalledTimes(2);
      // Upsert should handle duplicate gracefully with update: {}
    });

    it('should handle different user IDs', async () => {
      const userId1 = 'user-123';
      const userId2 = 'user-456';
      const adminRoleId = 'admin-role-id';

      prismaService.role.findUnique.mockResolvedValue({
        id: adminRoleId,
        name: 'admin',
        description: 'Admin role',
      } as any);

      prismaService.userRole.upsert.mockResolvedValue({} as any);

      await service.assignAdminRole(userId1);
      await service.assignAdminRole(userId2);

      expect(prismaService.userRole.upsert).toHaveBeenCalledTimes(2);
      expect(prismaService.userRole.upsert).toHaveBeenNthCalledWith(1, {
        where: {
          userId_roleId: {
            userId: userId1,
            roleId: adminRoleId,
          },
        },
        update: {},
        create: {
          userId: userId1,
          roleId: adminRoleId,
        },
      });

      expect(prismaService.userRole.upsert).toHaveBeenNthCalledWith(2, {
        where: {
          userId_roleId: {
            userId: userId2,
            roleId: adminRoleId,
          },
        },
        update: {},
        create: {
          userId: userId2,
          roleId: adminRoleId,
        },
      });
    });
  });
});
