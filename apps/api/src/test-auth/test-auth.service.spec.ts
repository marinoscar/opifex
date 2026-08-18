import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TestAuthService } from './test-auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService, mockPrismaTransaction } from '../../test/mocks/prisma.mock';
import { TestLoginDto } from './dto/test-login.dto';

describe('TestAuthService', () => {
  let service: TestAuthService;
  let mockPrisma: MockPrismaService;
  let mockJwtService: jest.Mocked<JwtService>;
  let mockConfigService: jest.Mocked<ConfigService>;

  const mockViewerRole = {
    id: 'role-viewer',
    name: 'viewer',
    description: 'Viewer role',
    isSystemRole: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockAdminRole = {
    id: 'role-admin',
    name: 'admin',
    description: 'Admin role',
    isSystemRole: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockContributorRole = {
    id: 'role-contributor',
    name: 'contributor',
    description: 'Contributor role',
    isSystemRole: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    // Setup transaction mock to handle both array and callback forms
    mockPrismaTransaction.call({ $transaction: mockPrisma.$transaction });
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') {
        return arg(mockPrisma);
      } else if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      return arg;
    });

    mockJwtService = {
      sign: jest.fn().mockReturnValue('mock-jwt-token'),
      signAsync: jest.fn().mockResolvedValue('mock-jwt-token'),
      verify: jest.fn(),
    } as any;
    mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, any> = {
          'jwt.accessTtlMinutes': 15,
          'jwt.refreshTtlDays': 14,
        };
        return config[key];
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestAuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<TestAuthService>(TestAuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('loginAsTestUser', () => {
    it('should create a new user if email does not exist', async () => {
      const dto: TestLoginDto = {
        email: 'newuser@example.com',
        role: 'viewer',
      };

      const mockUser = {
        id: 'user-1',
        email: dto.email,
        displayName: 'newuser',
        providerDisplayName: null,
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [{ role: mockViewerRole }],
      };

      mockPrisma.user.findUnique.mockResolvedValueOnce(null); // First check: user doesn't exist
      mockPrisma.role.findUnique.mockResolvedValue(mockViewerRole as any);
      mockPrisma.user.create.mockResolvedValue(mockUser as any);
      mockPrisma.userRole.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.userRole.create.mockResolvedValue({} as any);
      mockPrisma.user.findUnique.mockResolvedValueOnce(mockUser as any); // Reload after role assignment
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const result = await service.loginAsTestUser(dto);

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('expiresIn');
      expect(result).toHaveProperty('refreshToken');
      expect(result.user.email).toBe(dto.email);
      expect(result.user.roles).toContain('viewer');
      expect(mockPrisma.user.create).toHaveBeenCalled();
    });

    it('should find existing user if email exists', async () => {
      const dto: TestLoginDto = {
        email: 'existing@example.com',
        role: 'viewer',
      };

      const existingUser = {
        id: 'existing-user',
        email: dto.email,
        displayName: 'Existing User',
        providerDisplayName: null,
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [{ role: mockViewerRole }],
      };

      mockPrisma.user.findUnique.mockResolvedValueOnce(existingUser as any);
      mockPrisma.role.findUnique.mockResolvedValue(mockViewerRole as any);
      mockPrisma.userRole.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.userRole.create.mockResolvedValue({} as any);
      mockPrisma.user.findUnique.mockResolvedValueOnce(existingUser as any); // Reload after role assignment
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const result = await service.loginAsTestUser(dto);

      expect(result.user.email).toBe(dto.email);
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(result.user.id).toBe('existing-user');
    });

    it('should assign the specified role', async () => {
      const dto: TestLoginDto = {
        email: 'admin@example.com',
        role: 'admin',
      };

      const mockUser = {
        id: 'user-admin',
        email: dto.email,
        displayName: 'admin',
        providerDisplayName: null,
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [{ role: mockAdminRole }],
      };

      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null) // First check
        .mockResolvedValueOnce(mockUser as any); // Reload after role assignment
      mockPrisma.role.findUnique.mockResolvedValue(mockAdminRole as any);
      mockPrisma.user.create.mockResolvedValue(mockUser as any);
      mockPrisma.userRole.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.userRole.create.mockResolvedValue({} as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const result = await service.loginAsTestUser(dto);

      expect(mockPrisma.role.findUnique).toHaveBeenCalledWith({
        where: { name: 'admin' },
      });
      expect(result.user.roles).toContain('admin');
    });

    it('should generate valid access token', async () => {
      const dto: TestLoginDto = {
        email: 'token@example.com',
        role: 'viewer',
      };

      const mockUser = {
        id: 'user-token',
        email: dto.email,
        displayName: 'token',
        providerDisplayName: null,
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [{ role: mockViewerRole }],
      };

      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockUser as any);
      mockPrisma.role.findUnique.mockResolvedValue(mockViewerRole as any);
      mockPrisma.user.create.mockResolvedValue(mockUser as any);
      mockPrisma.userRole.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.userRole.create.mockResolvedValue({} as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const result = await service.loginAsTestUser(dto);

      expect(mockJwtService.sign).toHaveBeenCalledWith({
        sub: mockUser.id,
        email: mockUser.email,
        roles: ['viewer'],
      });
      expect(result.accessToken).toBe('mock-jwt-token');
    });

    it('should create refresh token in database', async () => {
      const dto: TestLoginDto = {
        email: 'refresh@example.com',
        role: 'viewer',
      };

      const mockUser = {
        id: 'user-refresh',
        email: dto.email,
        displayName: 'refresh',
        providerDisplayName: null,
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [{ role: mockViewerRole }],
      };

      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockUser as any);
      mockPrisma.role.findUnique.mockResolvedValue(mockViewerRole as any);
      mockPrisma.user.create.mockResolvedValue(mockUser as any);
      mockPrisma.userRole.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.userRole.create.mockResolvedValue({} as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const result = await service.loginAsTestUser(dto);

      expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith({
        data: {
          userId: mockUser.id,
          tokenHash: expect.any(String),
          expiresAt: expect.any(Date),
        },
      });
      expect(result.refreshToken).toBeDefined();
      expect(typeof result.refreshToken).toBe('string');
    });

    it('should use default role (viewer) when not specified', async () => {
      const dto = {
        email: 'default@example.com',
        // role is optional, should default to 'viewer'
      } as TestLoginDto;

      const mockUser = {
        id: 'user-default',
        email: dto.email,
        displayName: 'default',
        providerDisplayName: null,
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [{ role: mockViewerRole }],
      };

      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockUser as any);
      mockPrisma.role.findUnique.mockResolvedValue(mockViewerRole as any);
      mockPrisma.user.create.mockResolvedValue(mockUser as any);
      mockPrisma.userRole.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.userRole.create.mockResolvedValue({} as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const result = await service.loginAsTestUser(dto);

      expect(mockPrisma.role.findUnique).toHaveBeenCalledWith({
        where: { name: 'viewer' },
      });
      expect(result.user.roles).toContain('viewer');
    });

    it('should work with contributor role', async () => {
      const dto: TestLoginDto = {
        email: 'contributor@example.com',
        role: 'contributor',
      };

      const mockUser = {
        id: 'user-contrib',
        email: dto.email,
        displayName: 'contributor',
        providerDisplayName: null,
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [{ role: mockContributorRole }],
      };

      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockUser as any);
      mockPrisma.role.findUnique.mockResolvedValue(mockContributorRole as any);
      mockPrisma.user.create.mockResolvedValue(mockUser as any);
      mockPrisma.userRole.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.userRole.create.mockResolvedValue({} as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const result = await service.loginAsTestUser(dto);

      expect(result.user.roles).toContain('contributor');
    });

    it('should use email prefix as displayName when not provided', async () => {
      const dto: TestLoginDto = {
        email: 'testuser@example.com',
        role: 'viewer',
      };

      const mockUser = {
        id: 'user-prefix',
        email: dto.email,
        displayName: 'testuser',
        providerDisplayName: null,
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [{ role: mockViewerRole }],
      };

      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockUser as any);
      mockPrisma.role.findUnique.mockResolvedValue(mockViewerRole as any);
      mockPrisma.user.create.mockResolvedValue(mockUser as any);
      mockPrisma.userRole.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.userRole.create.mockResolvedValue({} as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const result = await service.loginAsTestUser(dto);

      expect(result.user.displayName).toBe('testuser');
    });

    it('should use provided displayName when specified', async () => {
      const dto: TestLoginDto = {
        email: 'custom@example.com',
        role: 'viewer',
        displayName: 'Custom Display Name',
      };

      const mockUser = {
        id: 'user-custom',
        email: dto.email,
        displayName: dto.displayName,
        providerDisplayName: null,
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [{ role: mockViewerRole }],
      };

      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockUser as any);
      mockPrisma.role.findUnique.mockResolvedValue(mockViewerRole as any);
      mockPrisma.user.create.mockResolvedValue(mockUser as any);
      mockPrisma.userRole.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.userRole.create.mockResolvedValue({} as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const result = await service.loginAsTestUser(dto);

      expect(result.user.displayName).toBe('Custom Display Name');
    });

    it('should normalize email to lowercase', async () => {
      const dto: TestLoginDto = {
        email: 'UPPERCASE@EXAMPLE.COM',
        role: 'viewer',
      };

      const mockUser = {
        id: 'user-upper',
        email: 'uppercase@example.com',
        displayName: 'UPPERCASE',
        providerDisplayName: null,
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [{ role: mockViewerRole }],
      };

      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockUser as any);
      mockPrisma.role.findUnique.mockResolvedValue(mockViewerRole as any);
      mockPrisma.user.create.mockResolvedValue(mockUser as any);
      mockPrisma.userRole.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.userRole.create.mockResolvedValue({} as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      await service.loginAsTestUser(dto);

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'uppercase@example.com' },
        }),
      );
    });

    it('should throw error when role not found', async () => {
      const dto: TestLoginDto = {
        email: 'invalid@example.com',
        role: 'viewer',
      };

      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.role.findUnique.mockResolvedValue(null); // Role not found

      await expect(service.loginAsTestUser(dto)).rejects.toThrow('Role viewer not found');
    });

    it('should replace existing roles when logging in', async () => {
      const dto: TestLoginDto = {
        email: 'existing@example.com',
        role: 'admin',
      };

      const existingUser = {
        id: 'existing-user',
        email: dto.email,
        displayName: 'Existing User',
        providerDisplayName: null,
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [{ role: mockViewerRole }], // Currently has viewer
      };

      const updatedUser = {
        ...existingUser,
        userRoles: [{ role: mockAdminRole }], // Now has admin
      };

      mockPrisma.user.findUnique
        .mockResolvedValueOnce(existingUser as any)
        .mockResolvedValueOnce(updatedUser as any);
      mockPrisma.role.findUnique.mockResolvedValue(mockAdminRole as any);
      mockPrisma.userRole.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.userRole.create.mockResolvedValue({} as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const result = await service.loginAsTestUser(dto);

      expect(mockPrisma.userRole.deleteMany).toHaveBeenCalledWith({
        where: { userId: existingUser.id },
      });
      expect(mockPrisma.userRole.create).toHaveBeenCalledWith({
        data: {
          userId: existingUser.id,
          roleId: mockAdminRole.id,
        },
      });
      expect(result.user.roles).toContain('admin');
    });

    it('should create user settings for new users', async () => {
      const dto: TestLoginDto = {
        email: 'newsettings@example.com',
        role: 'viewer',
      };

      const mockUser = {
        id: 'user-settings',
        email: dto.email,
        displayName: 'newsettings',
        providerDisplayName: null,
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [{ role: mockViewerRole }],
      };

      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockUser as any);
      mockPrisma.role.findUnique.mockResolvedValue(mockViewerRole as any);
      mockPrisma.user.create.mockResolvedValue(mockUser as any);
      mockPrisma.userRole.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.userRole.create.mockResolvedValue({} as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      await service.loginAsTestUser(dto);

      // Verify user settings were created
      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userSettings: expect.objectContaining({
              create: expect.objectContaining({
                value: expect.any(Object),
              }),
            }),
          }),
        }),
      );
    });

    it('should return correct expiresIn value', async () => {
      const dto: TestLoginDto = {
        email: 'expires@example.com',
        role: 'viewer',
      };

      const mockUser = {
        id: 'user-expires',
        email: dto.email,
        displayName: 'expires',
        providerDisplayName: null,
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [{ role: mockViewerRole }],
      };

      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockUser as any);
      mockPrisma.role.findUnique.mockResolvedValue(mockViewerRole as any);
      mockPrisma.user.create.mockResolvedValue(mockUser as any);
      mockPrisma.userRole.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.userRole.create.mockResolvedValue({} as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const result = await service.loginAsTestUser(dto);

      // 15 minutes * 60 seconds = 900 seconds
      expect(result.expiresIn).toBe(900);
    });
  });
});
