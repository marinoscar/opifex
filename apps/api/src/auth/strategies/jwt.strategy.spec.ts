import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { AuthService } from '../auth.service';
import type { RequestWithCredentialKind } from '../credential-kind';

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
          // `getOrThrow`, because that is what the strategy calls since #278
          // removed its `|| 'fallback-secret'`. The old fixture stubbed only
          // `get`, and the value it returned was 28 characters despite its
          // name — below the floor `validateEnv` now enforces, so it is
          // lengthened here too rather than left as a fixture that would fail
          // the real check.
          provide: ConfigService,
          useValue: {
            get: jest
              .fn()
              .mockReturnValue('test-jwt-secret-of-min-32-characters'),
            getOrThrow: jest
              .fn()
              .mockReturnValue('test-jwt-secret-of-min-32-characters'),
          },
        },
      ],
    }).compile();

    strategy = module.get<JwtStrategy>(JwtStrategy);
  });

  describe('validate', () => {
    it('should return user from auth service', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        isActive: true,
      };
      mockAuthService.validateJwtPayload.mockResolvedValue(mockUser as any);

      const payload = {
        sub: 'user-1',
        email: 'test@example.com',
        roles: ['viewer'],
      };
      const req: RequestWithCredentialKind = {};
      const result = await strategy.validate(req, payload);

      expect(result).toEqual(mockUser);
      expect(mockAuthService.validateJwtPayload).toHaveBeenCalledWith(payload);
    });

    it('should throw when auth service returns null', async () => {
      mockAuthService.validateJwtPayload.mockResolvedValue(null);

      const payload = { sub: 'invalid', email: 'test@example.com', roles: [] };

      await expect(strategy.validate({}, payload)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw when auth service throws', async () => {
      mockAuthService.validateJwtPayload.mockRejectedValue(
        new UnauthorizedException('Invalid user'),
      );

      const payload = { sub: 'invalid', email: 'test@example.com', roles: [] };

      await expect(strategy.validate({}, payload)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    // #346. The strategy is the only place the VERIFIED payload exists, so it
    // is the only place the credential kind can be read without decoding the
    // token a second time.
    describe('credential kind (#346)', () => {
      beforeEach(() => {
        mockAuthService.validateJwtPayload.mockResolvedValue({
          id: 'user-1',
        } as any);
      });

      it('records an interactive session on the request', async () => {
        const req: RequestWithCredentialKind = {};

        await strategy.validate(req, {
          sub: 'user-1',
          email: 'test@example.com',
          roles: [],
          cred: 'interactive',
        });

        expect(req.credentialKind).toBe('interactive');
      });

      it('records a device-flow token on the request', async () => {
        const req: RequestWithCredentialKind = {};

        await strategy.validate(req, {
          sub: 'user-1',
          email: 'test@example.com',
          roles: [],
          cred: 'device-code',
        });

        expect(req.credentialKind).toBe('device-code');
      });

      it('records a token with no claim as unknown, not as interactive', async () => {
        // The fail-closed direction, and the one a refactor is most likely to
        // reverse: a token minted before #346 shipped carries no `cred`, and
        // reading its absence as proof of a human is exactly the silent
        // privilege escalation this guard exists to stop.
        const req: RequestWithCredentialKind = {};

        await strategy.validate(req, {
          sub: 'user-1',
          email: 'test@example.com',
          roles: [],
        });

        expect(req.credentialKind).toBe('unknown');
      });

      it('does not attach the user to the request itself', async () => {
        // The kind is a property of the REQUEST, not of the person: the same
        // admin is interactive in a browser tab and not interactive in a cron
        // job, and only one of those two facts outlives the request.
        const req: RequestWithCredentialKind & { user?: unknown } = {};

        await strategy.validate(req, {
          sub: 'user-1',
          email: 'test@example.com',
          roles: [],
          cred: 'interactive',
        });

        expect(req.user).toBeUndefined();
      });
    });
  });
});
