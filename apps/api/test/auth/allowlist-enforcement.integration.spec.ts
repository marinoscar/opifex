import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../../src/auth/auth.service';
import { AllowlistService } from '../../src/allowlist/allowlist.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AdminBootstrapService } from '../../src/common/services/admin-bootstrap.service';
import { ForbiddenException } from '@nestjs/common';
import { resetPrismaMock, prismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockUserWithRelations, mockRoles } from '../fixtures/test-data.factory';
import { GoogleProfile } from '../../src/auth/strategies/google.strategy';

describe('Auth Service - Allowlist Enforcement', () => {
  let authService: AuthService;
  let allowlistService: AllowlistService;
  let mockConfigService: Partial<ConfigService>;

  const mockGoogleProfile: GoogleProfile = {
    id: 'google-12345',
    email: 'test@example.com',
    displayName: 'Test User',
    picture: 'https://example.com/photo.jpg',
  };

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();

    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          'jwt.accessTtlMinutes': 15,
          'jwt.refreshTtlDays': 14,
          JWT_SECRET: 'test-secret',
          INITIAL_ADMIN_EMAIL: 'admin@example.com',
        };
        return config[key] ?? defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        AllowlistService,
        AdminBootstrapService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: JwtService, useValue: { sign: jest.fn(() => 'mock-jwt-token'), signAsync: jest.fn(() => 'mock-jwt-token') } },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    authService = module.get<AuthService>(AuthService);
    allowlistService = module.get<AllowlistService>(AllowlistService);

    // Setup role mocks with userRoles for admin bootstrap
    prismaMock.role.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.name === 'viewer') {
        return mockRoles.viewer as any;
      }
      if (where.name === 'admin') {
        return { ...mockRoles.admin, userRoles: [] } as any;
      }
      return null;
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('OAuth login with allowlist enforcement', () => {
    it('should allow login for allowlisted email', async () => {
      const profile: GoogleProfile = {
        ...mockGoogleProfile,
        email: 'allowed@example.com',
      };

      // Mock allowlist check - email is allowed
      prismaMock.allowedEmail.findUnique.mockResolvedValue({
        id: 'allowed-1',
        email: profile.email.toLowerCase(),
        notes: null,
        addedById: 'admin-id',
        addedAt: new Date(),
        claimedById: null,
        claimedAt: null,
      } as any);

      // Mock no existing identity
      prismaMock.userIdentity.findUnique.mockResolvedValue(null);

      // Mock no existing user
      prismaMock.user.findUnique.mockResolvedValue(null);

      // Mock transaction
      prismaMock.$transaction.mockImplementation(async (callback: any) =>
        callback(prismaMock),
      );

      // Mock user creation
      const newUser = createMockUserWithRelations({
        email: profile.email,
        roleName: 'viewer',
      });
      prismaMock.user.create.mockResolvedValue(newUser as any);
      prismaMock.user.update.mockResolvedValue(newUser as any);
      prismaMock.refreshToken.create.mockResolvedValue({} as any);

      // Mock allowlist update (marking as claimed)
      prismaMock.allowedEmail.update.mockResolvedValue({} as any);

      const result = await authService.handleGoogleLogin(profile);

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(prismaMock.user.create).toHaveBeenCalled();
    });

    it('should deny login for non-allowlisted email', async () => {
      const profile: GoogleProfile = {
        ...mockGoogleProfile,
        email: 'notallowed@example.com',
      };

      // Mock allowlist check - email is NOT allowed
      prismaMock.allowedEmail.findUnique.mockResolvedValue(null);

      // Mock no existing identity
      prismaMock.userIdentity.findUnique.mockResolvedValue(null);

      await expect(authService.handleGoogleLogin(profile)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(authService.handleGoogleLogin(profile)).rejects.toThrow(
        'Your email is not authorized to access this application',
      );

      // Should not create user
      expect(prismaMock.user.create).not.toHaveBeenCalled();
    });

    it('should allow login for INITIAL_ADMIN_EMAIL even if not in allowlist', async () => {
      const profile: GoogleProfile = {
        ...mockGoogleProfile,
        email: 'admin@example.com',
      };

      // Mock allowlist check - email is NOT in allowlist
      prismaMock.allowedEmail.findUnique.mockResolvedValue(null);

      // Mock no existing identity
      prismaMock.userIdentity.findUnique.mockResolvedValue(null);

      // Mock no existing user
      prismaMock.user.findUnique.mockResolvedValue(null);

      // Mock transaction
      prismaMock.$transaction.mockImplementation(async (callback: any) =>
        callback(prismaMock),
      );

      // Mock user creation
      const newUser = createMockUserWithRelations({
        email: profile.email,
        roleName: 'admin',
      });
      prismaMock.user.create.mockResolvedValue(newUser as any);
      // Mock the user.findUnique call in transaction when reloading user with admin role
      prismaMock.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(newUser as any);
      prismaMock.user.update.mockResolvedValue(newUser as any);
      prismaMock.userRole.upsert.mockResolvedValue({} as any);
      prismaMock.refreshToken.create.mockResolvedValue({} as any);

      const result = await authService.handleGoogleLogin(profile);

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(prismaMock.user.create).toHaveBeenCalled();
    });

    it('should change allowlist entry status to claimed after successful login', async () => {
      const profile: GoogleProfile = {
        ...mockGoogleProfile,
        email: 'newuser@example.com',
      };

      const allowlistEntry = {
        id: 'allowed-1',
        email: profile.email.toLowerCase(),
        notes: null,
        addedById: 'admin-id',
        addedAt: new Date(),
        claimedById: null,
        claimedAt: null,
      };

      // Mock allowlist check - email is allowed
      prismaMock.allowedEmail.findUnique.mockResolvedValue(allowlistEntry as any);

      // Mock no existing identity
      prismaMock.userIdentity.findUnique.mockResolvedValue(null);

      // Mock no existing user
      prismaMock.user.findUnique.mockResolvedValue(null);

      // Mock transaction
      prismaMock.$transaction.mockImplementation(async (callback: any) =>
        callback(prismaMock),
      );

      // Mock user creation
      const newUser = createMockUserWithRelations({
        id: 'new-user-id',
        email: profile.email,
        roleName: 'viewer',
      });
      prismaMock.user.create.mockResolvedValue(newUser as any);
      prismaMock.user.update.mockResolvedValue(newUser as any);
      prismaMock.refreshToken.create.mockResolvedValue({} as any);

      // Mock allowlist update
      prismaMock.allowedEmail.update.mockResolvedValue({
        ...allowlistEntry,
        claimedById: newUser.id,
        claimedAt: new Date(),
      } as any);

      await authService.handleGoogleLogin(profile);

      // Verify allowlist entry was updated with user ID
      expect(prismaMock.allowedEmail.update).toHaveBeenCalledWith({
        where: { id: allowlistEntry.id },
        data: {
          claimedById: newUser.id,
          claimedAt: expect.any(Date),
        },
      });
    });

    it('should link userId to allowlist entry after login', async () => {
      const profile: GoogleProfile = {
        ...mockGoogleProfile,
        email: 'linktest@example.com',
      };

      const allowlistEntry = {
        id: 'allowed-link',
        email: profile.email.toLowerCase(),
        notes: null,
        addedById: 'admin-id',
        addedAt: new Date(),
        claimedById: null,
        claimedAt: null,
      };

      // Mock allowlist check
      prismaMock.allowedEmail.findUnique.mockResolvedValue(allowlistEntry as any);

      // Mock no existing identity
      prismaMock.userIdentity.findUnique.mockResolvedValue(null);

      // Mock no existing user
      prismaMock.user.findUnique.mockResolvedValue(null);

      // Mock transaction
      prismaMock.$transaction.mockImplementation(async (callback: any) =>
        callback(prismaMock),
      );

      // Mock user creation
      const newUser = createMockUserWithRelations({
        id: 'user-link-id',
        email: profile.email,
        roleName: 'viewer',
      });
      prismaMock.user.create.mockResolvedValue(newUser as any);
      prismaMock.user.update.mockResolvedValue(newUser as any);
      prismaMock.refreshToken.create.mockResolvedValue({} as any);

      // Mock allowlist update
      prismaMock.allowedEmail.update.mockResolvedValue({
        ...allowlistEntry,
        claimedById: newUser.id,
        claimedAt: new Date(),
      } as any);

      await authService.handleGoogleLogin(profile);

      // Verify userId was linked
      expect(prismaMock.allowedEmail.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            claimedById: newUser.id,
          }),
        }),
      );
    });

    it('should be case-insensitive for email allowlist check', async () => {
      const profile: GoogleProfile = {
        ...mockGoogleProfile,
        email: 'TestUser@Example.COM',
      };

      // Mock allowlist check - stored in lowercase
      prismaMock.allowedEmail.findUnique.mockResolvedValue({
        id: 'allowed-1',
        email: 'testuser@example.com',
        notes: null,
        addedById: 'admin-id',
        addedAt: new Date(),
        claimedById: null,
        claimedAt: null,
      } as any);

      // Mock no existing identity
      prismaMock.userIdentity.findUnique.mockResolvedValue(null);

      // Mock no existing user
      prismaMock.user.findUnique.mockResolvedValue(null);

      // Mock transaction
      prismaMock.$transaction.mockImplementation(async (callback: any) =>
        callback(prismaMock),
      );

      // Mock user creation
      const newUser = createMockUserWithRelations({
        email: profile.email.toLowerCase(),
        roleName: 'viewer',
      });
      prismaMock.user.create.mockResolvedValue(newUser as any);
      prismaMock.user.update.mockResolvedValue(newUser as any);
      prismaMock.refreshToken.create.mockResolvedValue({} as any);
      prismaMock.allowedEmail.update.mockResolvedValue({} as any);

      const result = await authService.handleGoogleLogin(profile);

      expect(result).toHaveProperty('accessToken');

      // Verify allowlist was checked with lowercase email
      expect(prismaMock.allowedEmail.findUnique).toHaveBeenCalledWith({
        where: { email: 'testuser@example.com' },
      });
    });

    it('should allow existing user to login if allowlisted (no user creation)', async () => {
      const profile: GoogleProfile = {
        ...mockGoogleProfile,
        email: 'existing@example.com',
      };

      // Mock allowlist check - email is allowed
      prismaMock.allowedEmail.findUnique.mockResolvedValue({
        id: 'allowed-1',
        email: profile.email.toLowerCase(),
        notes: null,
        addedById: 'admin-id',
        addedAt: new Date(),
        claimedById: 'existing-user-id',
        claimedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      } as any);

      // Mock existing identity with user
      const existingUser = createMockUserWithRelations({
        id: 'existing-user-id',
        email: profile.email,
        roleName: 'contributor',
      });

      prismaMock.userIdentity.findUnique.mockResolvedValue({
        id: 'identity-1',
        userId: existingUser.id,
        provider: 'google',
        providerSubject: profile.id,
        providerEmail: profile.email,
        createdAt: new Date(),
        user: existingUser,
      } as any);

      prismaMock.user.update.mockResolvedValue(existingUser as any);
      prismaMock.refreshToken.create.mockResolvedValue({} as any);

      const result = await authService.handleGoogleLogin(profile);

      expect(result).toHaveProperty('accessToken');
      expect(prismaMock.user.create).not.toHaveBeenCalled();
      expect(prismaMock.user.update).toHaveBeenCalled();
    });

    it('should deny login if user tries to login after being removed from allowlist (edge case)', async () => {
      const profile: GoogleProfile = {
        ...mockGoogleProfile,
        email: 'removed@example.com',
      };

      // Mock allowlist check - email is NOT allowed (was removed)
      // Note: In practice, claimed entries cannot be removed, but this tests the logic
      prismaMock.allowedEmail.findUnique.mockResolvedValue(null);

      // Mock existing identity (user was previously allowed)
      const existingUser = createMockUserWithRelations({
        id: 'existing-user-id',
        email: profile.email,
        roleName: 'viewer',
      });

      // Even though identity exists, allowlist check happens first
      prismaMock.userIdentity.findUnique.mockResolvedValue({
        id: 'identity-1',
        userId: existingUser.id,
        provider: 'google',
        providerSubject: profile.id,
        providerEmail: profile.email,
        createdAt: new Date(),
        user: existingUser,
      } as any);

      // Should fail because email is not in allowlist
      await expect(authService.handleGoogleLogin(profile)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
