import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePermissions } from '../../hooks/usePermissions';
import * as AuthContext from '../../contexts/AuthContext';
import { User } from '../../types';

// Mock the AuthContext
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}));

describe('usePermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial State', () => {
    it('should return empty permissions and roles when user is null', () => {
      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: null,
        isLoading: false,
        isAuthenticated: false,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.permissions.size).toBe(0);
      expect(result.current.roles.size).toBe(0);
      expect(result.current.isAdmin).toBe(false);
    });

    it('should return empty permissions and roles when user has empty arrays', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [],
        permissions: [],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.permissions.size).toBe(0);
      expect(result.current.roles.size).toBe(0);
      expect(result.current.isAdmin).toBe(false);
    });

    it('should populate permissions and roles from user', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }, { name: 'contributor' }],
        permissions: ['user_settings:read', 'user_settings:write', 'users:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.permissions.size).toBe(3);
      expect(result.current.roles.size).toBe(2);
      expect(result.current.permissions.has('user_settings:read')).toBe(true);
      expect(result.current.roles.has('viewer')).toBe(true);
      expect(result.current.roles.has('contributor')).toBe(true);
    });
  });

  describe('hasPermission', () => {
    it('should return true when user has the permission', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read', 'user_settings:write'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasPermission('user_settings:read')).toBe(true);
      expect(result.current.hasPermission('user_settings:write')).toBe(true);
    });

    it('should return false when user does not have the permission', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasPermission('system_settings:write')).toBe(false);
      expect(result.current.hasPermission('users:write')).toBe(false);
    });

    it('should return false when user is null', () => {
      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: null,
        isLoading: false,
        isAuthenticated: false,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasPermission('user_settings:read')).toBe(false);
    });

    it('should handle empty permission string', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasPermission('')).toBe(false);
    });
  });

  describe('hasAnyPermission', () => {
    it('should return true when user has at least one of the permissions', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read', 'user_settings:write'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(
        result.current.hasAnyPermission('user_settings:read', 'system_settings:write')
      ).toBe(true);
      expect(
        result.current.hasAnyPermission('users:read', 'user_settings:write')
      ).toBe(true);
    });

    it('should return false when user has none of the permissions', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(
        result.current.hasAnyPermission('system_settings:write', 'users:write')
      ).toBe(false);
    });

    it('should return false when given empty permission array', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasAnyPermission()).toBe(false);
    });

    it('should return false when user is null', () => {
      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: null,
        isLoading: false,
        isAuthenticated: false,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(
        result.current.hasAnyPermission('user_settings:read', 'user_settings:write')
      ).toBe(false);
    });

    it('should handle single permission check', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasAnyPermission('user_settings:read')).toBe(true);
      expect(result.current.hasAnyPermission('users:write')).toBe(false);
    });
  });

  describe('hasAllPermissions', () => {
    it('should return true when user has all of the permissions', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'contributor' }],
        permissions: ['user_settings:read', 'user_settings:write', 'users:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(
        result.current.hasAllPermissions('user_settings:read', 'user_settings:write')
      ).toBe(true);
      expect(
        result.current.hasAllPermissions('user_settings:read', 'users:read')
      ).toBe(true);
    });

    it('should return false when user is missing any of the permissions', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read', 'user_settings:write'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(
        result.current.hasAllPermissions('user_settings:read', 'system_settings:write')
      ).toBe(false);
      expect(
        result.current.hasAllPermissions('users:read', 'users:write')
      ).toBe(false);
    });

    it('should return true when given empty permission array', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      // Array.every returns true for empty array
      expect(result.current.hasAllPermissions()).toBe(true);
    });

    it('should return false when user is null', () => {
      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: null,
        isLoading: false,
        isAuthenticated: false,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(
        result.current.hasAllPermissions('user_settings:read', 'user_settings:write')
      ).toBe(false);
    });

    it('should handle single permission check', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasAllPermissions('user_settings:read')).toBe(true);
      expect(result.current.hasAllPermissions('users:write')).toBe(false);
    });
  });

  describe('hasRole', () => {
    it('should return true when user has the role', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }, { name: 'contributor' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasRole('viewer')).toBe(true);
      expect(result.current.hasRole('contributor')).toBe(true);
    });

    it('should return false when user does not have the role', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasRole('admin')).toBe(false);
      expect(result.current.hasRole('contributor')).toBe(false);
    });

    it('should return false when user is null', () => {
      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: null,
        isLoading: false,
        isAuthenticated: false,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasRole('viewer')).toBe(false);
    });

    it('should handle empty role string', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasRole('')).toBe(false);
    });

    it('should be case-sensitive', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'admin' }],
        permissions: [],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasRole('admin')).toBe(true);
      expect(result.current.hasRole('Admin')).toBe(false);
      expect(result.current.hasRole('ADMIN')).toBe(false);
    });
  });

  describe('hasAnyRole', () => {
    it('should return true when user has at least one of the roles', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }, { name: 'contributor' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasAnyRole('viewer', 'admin')).toBe(true);
      expect(result.current.hasAnyRole('contributor', 'admin')).toBe(true);
      expect(result.current.hasAnyRole('admin', 'viewer', 'contributor')).toBe(true);
    });

    it('should return false when user has none of the roles', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasAnyRole('admin', 'contributor')).toBe(false);
    });

    it('should return false when given empty role array', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasAnyRole()).toBe(false);
    });

    it('should return false when user is null', () => {
      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: null,
        isLoading: false,
        isAuthenticated: false,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasAnyRole('viewer', 'admin')).toBe(false);
    });

    it('should handle single role check', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.hasAnyRole('viewer')).toBe(true);
      expect(result.current.hasAnyRole('admin')).toBe(false);
    });
  });

  describe('isAdmin', () => {
    it('should return true when user has admin role', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'admin@example.com',
        displayName: 'Admin User',
        profileImageUrl: null,
        roles: [{ name: 'admin' }],
        permissions: ['system_settings:write', 'users:write', 'rbac:manage'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.isAdmin).toBe(true);
    });

    it('should return true when user has admin role along with other roles', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'admin@example.com',
        displayName: 'Admin User',
        profileImageUrl: null,
        roles: [{ name: 'admin' }, { name: 'contributor' }, { name: 'viewer' }],
        permissions: ['system_settings:write', 'users:write'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.isAdmin).toBe(true);
    });

    it('should return false when user does not have admin role', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }, { name: 'contributor' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.isAdmin).toBe(false);
    });

    it('should return false when user is null', () => {
      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: null,
        isLoading: false,
        isAuthenticated: false,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.isAdmin).toBe(false);
    });

    it('should be case-sensitive for admin check', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'Admin' }],
        permissions: [],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      // Should be false because it checks for lowercase 'admin'
      expect(result.current.isAdmin).toBe(false);
    });
  });

  describe('Memoization', () => {
    it('should memoize permissions set when user permissions do not change', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      const mockUseAuth = vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result, rerender } = renderHook(() => usePermissions());

      const firstPermissions = result.current.permissions;

      // Rerender with same user object
      rerender();

      const secondPermissions = result.current.permissions;

      // Should be the same Set instance due to memoization
      expect(firstPermissions).toBe(secondPermissions);

      mockUseAuth.mockRestore();
    });

    it('should update permissions set when user permissions change', () => {
      const mockUser1: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      const mockUseAuth = vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser1,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result, rerender } = renderHook(() => usePermissions());

      const firstPermissions = result.current.permissions;
      expect(firstPermissions.has('user_settings:read')).toBe(true);

      // Update mock to return different permissions
      const mockUser2: User = {
        ...mockUser1,
        permissions: ['user_settings:read', 'user_settings:write'],
      };

      mockUseAuth.mockReturnValue({
        user: mockUser2,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      rerender();

      const secondPermissions = result.current.permissions;

      // Should be a new Set with updated permissions
      expect(secondPermissions).not.toBe(firstPermissions);
      expect(secondPermissions.has('user_settings:write')).toBe(true);

      mockUseAuth.mockRestore();
    });

    it('should memoize roles set when user roles do not change', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      const mockUseAuth = vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result, rerender } = renderHook(() => usePermissions());

      const firstRoles = result.current.roles;

      rerender();

      const secondRoles = result.current.roles;

      expect(firstRoles).toBe(secondRoles);

      mockUseAuth.mockRestore();
    });

    it('should memoize isAdmin value', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'admin@example.com',
        displayName: 'Admin User',
        profileImageUrl: null,
        roles: [{ name: 'admin' }],
        permissions: ['system_settings:write'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      const mockUseAuth = vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result, rerender } = renderHook(() => usePermissions());

      const firstIsAdmin = result.current.isAdmin;

      rerender();

      const secondIsAdmin = result.current.isAdmin;

      expect(firstIsAdmin).toBe(secondIsAdmin);
      expect(firstIsAdmin).toBe(true);

      mockUseAuth.mockRestore();
    });
  });

  describe('Edge Cases', () => {
    it('should handle undefined permissions array', () => {
      const mockUser = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: undefined as any,
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.permissions.size).toBe(0);
      expect(result.current.hasPermission('any_permission')).toBe(false);
    });

    it('should handle undefined roles array', () => {
      const mockUser = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: undefined as any,
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.roles.size).toBe(0);
      expect(result.current.hasRole('any_role')).toBe(false);
      expect(result.current.isAdmin).toBe(false);
    });

    it('should handle user with null values', () => {
      const mockUser = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: null,
        profileImageUrl: null,
        roles: null as any,
        permissions: null as any,
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      expect(result.current.permissions.size).toBe(0);
      expect(result.current.roles.size).toBe(0);
      expect(result.current.hasPermission('any_permission')).toBe(false);
      expect(result.current.hasRole('any_role')).toBe(false);
      expect(result.current.isAdmin).toBe(false);
    });

    it('should handle duplicate permissions in user data', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read', 'user_settings:read', 'user_settings:write'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      // Set should deduplicate
      expect(result.current.permissions.size).toBe(2);
      expect(result.current.hasPermission('user_settings:read')).toBe(true);
      expect(result.current.hasPermission('user_settings:write')).toBe(true);
    });

    it('should handle duplicate roles in user data', () => {
      const mockUser: User = {
        id: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }, { name: 'viewer' }, { name: 'contributor' }],
        permissions: ['user_settings:read'],
        isActive: true,
        createdAt: '2024-01-01T00:00:00Z',
      };

      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: mockUser,
        isLoading: false,
        isAuthenticated: true,
        providers: [],
        login: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      });

      const { result } = renderHook(() => usePermissions());

      // Set should deduplicate
      expect(result.current.roles.size).toBe(2);
      expect(result.current.hasRole('viewer')).toBe(true);
      expect(result.current.hasRole('contributor')).toBe(true);
    });
  });
});
