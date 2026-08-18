import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(async () => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesGuard,
        { provide: Reflector, useValue: reflector },
      ],
    }).compile();

    guard = module.get<RolesGuard>(RolesGuard);
  });

  function createMockContext(user: Partial<AuthenticatedUser> | null = null): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as any;
  }

  function createUserWithRoles(roleNames: string[]): Partial<AuthenticatedUser> {
    return {
      id: 'user-id',
      email: 'test@example.com',
      isActive: true,
      userRoles: roleNames.map((name) => ({
        role: {
          id: `role-${name}`,
          name,
          description: `${name} role`,
          rolePermissions: [],
        },
      })),
    } as Partial<AuthenticatedUser>;
  }

  describe('canActivate', () => {
    it('should allow access when no roles required', () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      const context = createMockContext(createUserWithRoles(['viewer']));

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow access when roles array is empty', () => {
      reflector.getAllAndOverride.mockReturnValue([]);
      const context = createMockContext(createUserWithRoles(['viewer']));

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow access when user has required role', () => {
      reflector.getAllAndOverride.mockReturnValue(['admin']);
      const context = createMockContext(createUserWithRoles(['admin']));

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow access when user has one of multiple required roles', () => {
      reflector.getAllAndOverride.mockReturnValue(['admin', 'contributor']);
      const context = createMockContext(createUserWithRoles(['contributor']));

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should deny access when user lacks required role', () => {
      reflector.getAllAndOverride.mockReturnValue(['admin']);
      const context = createMockContext(createUserWithRoles(['viewer']));

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow('Required roles: admin');
    });

    it('should deny access when user has no roles', () => {
      reflector.getAllAndOverride.mockReturnValue(['admin']);
      const context = createMockContext(createUserWithRoles([]));

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should deny access when no user in request', () => {
      reflector.getAllAndOverride.mockReturnValue(['admin']);
      const context = createMockContext(null);

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow('No user in request');
    });

    it('should handle user with multiple roles', () => {
      reflector.getAllAndOverride.mockReturnValue(['contributor']);
      const context = createMockContext(createUserWithRoles(['viewer', 'contributor']));

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow when user has one of multiple required roles (first match)', () => {
      reflector.getAllAndOverride.mockReturnValue(['admin', 'contributor', 'viewer']);
      const context = createMockContext(createUserWithRoles(['admin']));

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow when user has one of multiple required roles (middle match)', () => {
      reflector.getAllAndOverride.mockReturnValue(['admin', 'contributor', 'viewer']);
      const context = createMockContext(createUserWithRoles(['contributor']));

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow when user has one of multiple required roles (last match)', () => {
      reflector.getAllAndOverride.mockReturnValue(['admin', 'contributor', 'viewer']);
      const context = createMockContext(createUserWithRoles(['viewer']));

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should attach requestUser to request on successful authorization', () => {
      reflector.getAllAndOverride.mockReturnValue(['admin']);
      const user = createUserWithRoles(['admin']);
      const request = { user };
      const context = {
        switchToHttp: () => ({
          getRequest: () => request,
        }),
        getHandler: () => jest.fn(),
        getClass: () => jest.fn(),
      } as any;

      guard.canActivate(context);

      expect(request).toHaveProperty('requestUser');
      expect((request as any).requestUser).toHaveProperty('id');
      expect((request as any).requestUser).toHaveProperty('roles');
      expect((request as any).requestUser.roles).toContain('admin');
    });
  });
});
