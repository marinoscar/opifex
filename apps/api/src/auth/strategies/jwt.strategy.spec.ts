import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { AuthService } from '../auth.service';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let mockAuthService: jest.Mocked<AuthService>;

  beforeEach(async () => {
    mockAuthService = {
      validateJwtPayload: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        { provide: AuthService, useValue: mockAuthService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('test-jwt-secret-min-32-chars'),
          },
        },
      ],
    }).compile();

    strategy = module.get<JwtStrategy>(JwtStrategy);
  });

  describe('validate', () => {
    it('should return user from auth service', async () => {
      const mockUser = { id: 'user-1', email: 'test@example.com', isActive: true };
      mockAuthService.validateJwtPayload.mockResolvedValue(mockUser as any);

      const payload = { sub: 'user-1', email: 'test@example.com', roles: ['viewer'] };
      const result = await strategy.validate(payload);

      expect(result).toEqual(mockUser);
      expect(mockAuthService.validateJwtPayload).toHaveBeenCalledWith(payload);
    });

    it('should throw when auth service returns null', async () => {
      mockAuthService.validateJwtPayload.mockResolvedValue(null);

      const payload = { sub: 'invalid', email: 'test@example.com', roles: [] };

      await expect(strategy.validate(payload)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw when auth service throws', async () => {
      mockAuthService.validateJwtPayload.mockRejectedValue(
        new UnauthorizedException('Invalid user'),
      );

      const payload = { sub: 'invalid', email: 'test@example.com', roles: [] };

      await expect(strategy.validate(payload)).rejects.toThrow(UnauthorizedException);
    });
  });
});
