import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TestEnvironmentGuard } from './test-environment.guard';

describe('TestEnvironmentGuard', () => {
  let guard: TestEnvironmentGuard;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    configService = {
      get: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestEnvironmentGuard,
        {
          provide: ConfigService,
          useValue: configService,
        },
      ],
    }).compile();

    guard = module.get<TestEnvironmentGuard>(TestEnvironmentGuard);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createMockContext(): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({}),
        getResponse: () => ({
          code: jest.fn().mockReturnThis(),
          send: jest.fn(),
        }),
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as any;
  }

  describe('canActivate', () => {
    it('should allow requests when NODE_ENV is development', () => {
      configService.get.mockReturnValue('development');
      const context = createMockContext();

      const result = guard.canActivate(context);

      expect(result).toBe(true);
      expect(configService.get).toHaveBeenCalledWith('nodeEnv');
    });

    it('should allow requests when NODE_ENV is test', () => {
      configService.get.mockReturnValue('test');
      const context = createMockContext();

      const result = guard.canActivate(context);

      expect(result).toBe(true);
      expect(configService.get).toHaveBeenCalledWith('nodeEnv');
    });

    it('should throw ForbiddenException when NODE_ENV is production', () => {
      configService.get.mockReturnValue('production');
      const context = createMockContext();

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow(
        'Test authentication endpoints are not available in production',
      );
    });

    it('should check nodeEnv from config service', () => {
      configService.get.mockReturnValue('development');
      const context = createMockContext();

      guard.canActivate(context);

      expect(configService.get).toHaveBeenCalledWith('nodeEnv');
    });

    it('should handle undefined NODE_ENV gracefully', () => {
      configService.get.mockReturnValue(undefined);
      const context = createMockContext();

      // Should allow when undefined (treat as non-production)
      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });

    it('should handle staging environment', () => {
      configService.get.mockReturnValue('staging');
      const context = createMockContext();

      // Should allow non-production environments
      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });
  });

  describe('Error handling', () => {
    it('should throw ForbiddenException with correct message', () => {
      configService.get.mockReturnValue('production');
      const context = createMockContext();

      try {
        guard.canActivate(context);
        fail('Should have thrown ForbiddenException');
      } catch (error: any) {
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(error.message).toBe(
          'Test authentication endpoints are not available in production',
        );
      }
    });
  });
});
