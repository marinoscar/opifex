import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PatService } from '../pat/pat.service';

describe('AuthController', () => {
  let controller: AuthController;
  let mockAuthService: jest.Mocked<AuthService>;
  let mockConfigService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    mockAuthService = {
      getEnabledProviders: jest.fn(),
      handleGoogleLogin: jest.fn(),
      getCurrentUser: jest.fn(),
      logout: jest.fn(),
    } as any;

    mockConfigService = {
      get: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: PatService, useValue: { validateToken: jest.fn() } },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  describe('getProviders', () => {
    it('should return enabled providers', async () => {
      const providers = [{ name: 'google', enabled: true }];
      mockAuthService.getEnabledProviders.mockResolvedValue(providers);

      const result = await controller.getProviders();

      expect(result).toEqual({
        data: {
          providers,
        },
      });
    });
  });

  describe('getCurrentUser', () => {
    it('should return current user details', async () => {
      const userDetails = {
        id: 'user-1',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        isActive: true,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
      };
      mockAuthService.getCurrentUser.mockResolvedValue(userDetails as any);

      const requestUser = { id: 'user-1', email: 'test@example.com' };
      const result = await controller.getCurrentUser(requestUser as any);

      expect(result).toEqual({
        data: userDetails,
      });
      expect(mockAuthService.getCurrentUser).toHaveBeenCalledWith('user-1');
    });
  });

  describe('logout', () => {
    it('should call auth service logout and return void', async () => {
      mockAuthService.logout.mockResolvedValue(undefined);

      const requestUser = { id: 'user-1', email: 'test@example.com' };
      const mockReq = { cookies: {} } as any;
      const mockRes = { clearCookie: jest.fn() } as any;

      const result = await controller.logout(requestUser as any, mockReq, mockRes);

      expect(result).toBeUndefined();
      expect(mockAuthService.logout).toHaveBeenCalledWith('user-1', undefined);
      expect(mockRes.clearCookie).toHaveBeenCalled();
    });
  });
});
