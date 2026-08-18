import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { RequirePermission } from '../../../components/common/RequirePermission';

// Mock usePermissions hook
vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { usePermissions } from '../../../hooks/usePermissions';

const mockUsePermissions = vi.mocked(usePermissions);

describe('RequirePermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default permission mock - viewer user with basic permissions
    mockUsePermissions.mockReturnValue({
      permissions: new Set(['user_settings:read', 'user_settings:write']),
      roles: new Set(['viewer']),
      hasPermission: (perm: string) =>
        perm === 'user_settings:read' || perm === 'user_settings:write',
      hasAnyPermission: (...perms: string[]) =>
        perms.some(
          (p) => p === 'user_settings:read' || p === 'user_settings:write'
        ),
      hasAllPermissions: (...perms: string[]) =>
        perms.every(
          (p) => p === 'user_settings:read' || p === 'user_settings:write'
        ),
      hasRole: (role: string) => role === 'viewer',
      hasAnyRole: (...roleList: string[]) => roleList.includes('viewer'),
      isAdmin: false,
    });
  });

  describe('Single Permission Check', () => {
    it('should render children when user has the required permission', () => {
      render(
        <RequirePermission permission="user_settings:read">
          <div>Protected Content</div>
        </RequirePermission>
      );

      expect(screen.getByText('Protected Content')).toBeInTheDocument();
    });

    it('should hide children when user lacks the required permission', () => {
      render(
        <RequirePermission permission="system_settings:write">
          <div>Admin Only Content</div>
        </RequirePermission>
      );

      expect(screen.queryByText('Admin Only Content')).not.toBeInTheDocument();
    });

    it('should render children when permission check passes', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['posts:create', 'posts:read']),
        roles: new Set(['contributor']),
        hasPermission: (perm: string) => perm === 'posts:create' || perm === 'posts:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(
        <RequirePermission permission="posts:create">
          <button>Create Post</button>
        </RequirePermission>
      );

      expect(screen.getByRole('button', { name: /create post/i })).toBeInTheDocument();
    });
  });

  describe('Multiple Permissions - Any Mode', () => {
    it('should render when user has at least one permission (requireAll=false)', () => {
      render(
        <RequirePermission
          permissions={['user_settings:read', 'system_settings:read']}
          requireAll={false}
        >
          <div>Settings Content</div>
        </RequirePermission>
      );

      expect(screen.getByText('Settings Content')).toBeInTheDocument();
    });

    it('should hide when user has none of the permissions (requireAll=false)', () => {
      render(
        <RequirePermission
          permissions={['system_settings:read', 'system_settings:write']}
          requireAll={false}
        >
          <div>Admin Settings</div>
        </RequirePermission>
      );

      expect(screen.queryByText('Admin Settings')).not.toBeInTheDocument();
    });

    it('should render when user has any permission from the list', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['posts:read']),
        roles: new Set(['viewer']),
        hasPermission: (perm: string) => perm === 'posts:read',
        hasAnyPermission: (...perms: string[]) => perms.includes('posts:read'),
        hasAllPermissions: vi.fn().mockReturnValue(false),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(
        <RequirePermission
          permissions={['posts:read', 'posts:write', 'posts:delete']}
          requireAll={false}
        >
          <div>Can View Posts</div>
        </RequirePermission>
      );

      expect(screen.getByText('Can View Posts')).toBeInTheDocument();
    });
  });

  describe('Multiple Permissions - All Mode', () => {
    it('should render when user has all required permissions (requireAll=true)', () => {
      render(
        <RequirePermission
          permissions={['user_settings:read', 'user_settings:write']}
          requireAll={true}
        >
          <div>Edit Settings</div>
        </RequirePermission>
      );

      expect(screen.getByText('Edit Settings')).toBeInTheDocument();
    });

    it('should hide when user lacks any required permission (requireAll=true)', () => {
      render(
        <RequirePermission
          permissions={['user_settings:read', 'system_settings:read']}
          requireAll={true}
        >
          <div>All Settings</div>
        </RequirePermission>
      );

      expect(screen.queryByText('All Settings')).not.toBeInTheDocument();
    });

    it('should hide when user has only some permissions (requireAll=true)', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['posts:read', 'posts:write']),
        roles: new Set(['contributor']),
        hasPermission: (perm: string) =>
          perm === 'posts:read' || perm === 'posts:write',
        hasAnyPermission: vi.fn().mockReturnValue(true),
        hasAllPermissions: (...perms: string[]) =>
          perms.every((p) => p === 'posts:read' || p === 'posts:write'),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(
        <RequirePermission
          permissions={['posts:read', 'posts:write', 'posts:delete']}
          requireAll={true}
        >
          <div>Full Access</div>
        </RequirePermission>
      );

      expect(screen.queryByText('Full Access')).not.toBeInTheDocument();
    });
  });

  describe('Role-Based Access Control', () => {
    it('should render when user has the required role', () => {
      render(
        <RequirePermission role="viewer">
          <div>Viewer Content</div>
        </RequirePermission>
      );

      expect(screen.getByText('Viewer Content')).toBeInTheDocument();
    });

    it('should hide when user lacks the required role', () => {
      render(
        <RequirePermission role="admin">
          <div>Admin Panel</div>
        </RequirePermission>
      );

      expect(screen.queryByText('Admin Panel')).not.toBeInTheDocument();
    });

    it('should render when user has any of the required roles', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set([]),
        roles: new Set(['contributor']),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: (role: string) => role === 'contributor',
        hasAnyRole: (...roleList: string[]) => roleList.includes('contributor'),
        isAdmin: false,
      });

      render(
        <RequirePermission roles={['admin', 'contributor', 'viewer']}>
          <div>Multi-Role Content</div>
        </RequirePermission>
      );

      expect(screen.getByText('Multi-Role Content')).toBeInTheDocument();
    });

    it('should hide when user has none of the required roles', () => {
      render(
        <RequirePermission roles={['admin', 'contributor']}>
          <div>Elevated Access</div>
        </RequirePermission>
      );

      expect(screen.queryByText('Elevated Access')).not.toBeInTheDocument();
    });
  });

  describe('Fallback Rendering', () => {
    it('should render fallback when permission is denied', () => {
      render(
        <RequirePermission
          permission="system_settings:write"
          fallback={<div>Access Denied</div>}
        >
          <div>Protected Content</div>
        </RequirePermission>
      );

      expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
      expect(screen.getByText('Access Denied')).toBeInTheDocument();
    });

    it('should render custom fallback component', () => {
      const CustomFallback = () => (
        <div>
          <h2>Insufficient Permissions</h2>
          <p>Please contact your administrator</p>
        </div>
      );

      render(
        <RequirePermission
          permission="users:write"
          fallback={<CustomFallback />}
        >
          <div>User Management</div>
        </RequirePermission>
      );

      expect(screen.queryByText('User Management')).not.toBeInTheDocument();
      expect(screen.getByText('Insufficient Permissions')).toBeInTheDocument();
      expect(screen.getByText('Please contact your administrator')).toBeInTheDocument();
    });

    it('should render fallback for role check failure', () => {
      render(
        <RequirePermission role="admin" fallback={<div>Admins Only</div>}>
          <div>Admin Dashboard</div>
        </RequirePermission>
      );

      expect(screen.queryByText('Admin Dashboard')).not.toBeInTheDocument();
      expect(screen.getByText('Admins Only')).toBeInTheDocument();
    });

    it('should render fallback when multiple permissions check fails', () => {
      render(
        <RequirePermission
          permissions={['system_settings:read', 'users:read']}
          requireAll={true}
          fallback={<div>Restricted Area</div>}
        >
          <div>Admin Area</div>
        </RequirePermission>
      );

      expect(screen.queryByText('Admin Area')).not.toBeInTheDocument();
      expect(screen.getByText('Restricted Area')).toBeInTheDocument();
    });
  });

  describe('Null Fallback', () => {
    it('should hide content completely when fallback is null (default)', () => {
      const { container } = render(
        <RequirePermission permission="system_settings:write">
          <div>Admin Content</div>
        </RequirePermission>
      );

      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
      expect(container.textContent).toBe('');
    });

    it('should hide content when explicitly passing null fallback', () => {
      const { container } = render(
        <RequirePermission permission="users:delete" fallback={null}>
          <button>Delete User</button>
        </RequirePermission>
      );

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(container.textContent).toBe('');
    });

    it('should render nothing when permission denied and no fallback provided', () => {
      const { container } = render(
        <div data-testid="wrapper">
          <RequirePermission permission="nonexistent:permission">
            <div>Hidden Content</div>
          </RequirePermission>
        </div>
      );

      const wrapper = screen.getByTestId('wrapper');
      expect(wrapper.textContent).toBe('');
    });
  });

  describe('Combined Permissions and Roles', () => {
    it('should check both permission and role', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['posts:create']),
        roles: new Set(['contributor']),
        hasPermission: (perm: string) => perm === 'posts:create',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: (role: string) => role === 'contributor',
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(
        <RequirePermission permission="posts:create" role="contributor">
          <div>Create Post</div>
        </RequirePermission>
      );

      expect(screen.getByText('Create Post')).toBeInTheDocument();
    });

    it('should hide when permission passes but role fails', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['posts:create']),
        roles: new Set(['viewer']),
        hasPermission: (perm: string) => perm === 'posts:create',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: (role: string) => role === 'viewer',
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(
        <RequirePermission permission="posts:create" role="admin">
          <div>Admin Post</div>
        </RequirePermission>
      );

      expect(screen.queryByText('Admin Post')).not.toBeInTheDocument();
    });

    it('should hide when role passes but permission fails', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['posts:read']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) => perm === 'posts:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: (role: string) => role === 'admin',
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(
        <RequirePermission permission="posts:delete" role="admin">
          <div>Delete Post</div>
        </RequirePermission>
      );

      expect(screen.queryByText('Delete Post')).not.toBeInTheDocument();
    });

    it('should check multiple permissions and multiple roles', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['users:read', 'users:write']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) =>
          perm === 'users:read' || perm === 'users:write',
        hasAnyPermission: (...perms: string[]) =>
          perms.some((p) => p === 'users:read' || p === 'users:write'),
        hasAllPermissions: (...perms: string[]) =>
          perms.every((p) => p === 'users:read' || p === 'users:write'),
        hasRole: (role: string) => role === 'admin',
        hasAnyRole: (...roleList: string[]) => roleList.includes('admin'),
        isAdmin: true,
      });

      render(
        <RequirePermission
          permissions={['users:read', 'users:write']}
          requireAll={true}
          roles={['admin', 'super_admin']}
        >
          <div>User Management</div>
        </RequirePermission>
      );

      expect(screen.getByText('User Management')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty permissions array', () => {
      render(
        <RequirePermission permissions={[]}>
          <div>Always Visible</div>
        </RequirePermission>
      );

      expect(screen.getByText('Always Visible')).toBeInTheDocument();
    });

    it('should handle empty roles array', () => {
      render(
        <RequirePermission roles={[]}>
          <div>Always Visible</div>
        </RequirePermission>
      );

      expect(screen.getByText('Always Visible')).toBeInTheDocument();
    });

    it('should render when no permission or role props provided', () => {
      render(
        <RequirePermission>
          <div>No Restrictions</div>
        </RequirePermission>
      );

      expect(screen.getByText('No Restrictions')).toBeInTheDocument();
    });

    it('should handle unauthenticated users', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn().mockReturnValue(false),
        hasAnyPermission: vi.fn().mockReturnValue(false),
        hasAllPermissions: vi.fn().mockReturnValue(false),
        hasRole: vi.fn().mockReturnValue(false),
        hasAnyRole: vi.fn().mockReturnValue(false),
        isAdmin: false,
      });

      render(
        <RequirePermission permission="user_settings:read">
          <div>Settings</div>
        </RequirePermission>
      );

      expect(screen.queryByText('Settings')).not.toBeInTheDocument();
    });

    it('should handle user with no permissions', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(),
        roles: new Set(['guest']),
        hasPermission: vi.fn().mockReturnValue(false),
        hasAnyPermission: vi.fn().mockReturnValue(false),
        hasAllPermissions: vi.fn().mockReturnValue(false),
        hasRole: (role: string) => role === 'guest',
        hasAnyRole: (roleList: string[]) => roleList.includes('guest'),
        isAdmin: false,
      });

      render(
        <RequirePermission permission="posts:read">
          <div>Posts</div>
        </RequirePermission>
      );

      expect(screen.queryByText('Posts')).not.toBeInTheDocument();
    });

    it('should handle user with no roles', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['posts:read']),
        roles: new Set(),
        hasPermission: (perm: string) => perm === 'posts:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn().mockReturnValue(false),
        hasAnyRole: vi.fn().mockReturnValue(false),
        isAdmin: false,
      });

      render(
        <RequirePermission role="viewer">
          <div>Role Required</div>
        </RequirePermission>
      );

      expect(screen.queryByText('Role Required')).not.toBeInTheDocument();
    });

    it('should render complex nested children', () => {
      render(
        <RequirePermission permission="user_settings:read">
          <div>
            <h1>Settings</h1>
            <p>Configuration options</p>
            <button>Save</button>
          </div>
        </RequirePermission>
      );

      expect(screen.getByRole('heading', { name: /settings/i })).toBeInTheDocument();
      expect(screen.getByText('Configuration options')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    });

    it('should handle special characters in permission names', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['user:profile:update']),
        roles: new Set(['viewer']),
        hasPermission: (perm: string) => perm === 'user:profile:update',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(
        <RequirePermission permission="user:profile:update">
          <div>Update Profile</div>
        </RequirePermission>
      );

      expect(screen.getByText('Update Profile')).toBeInTheDocument();
    });
  });

  describe('Admin User Scenarios', () => {
    beforeEach(() => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set([
          'user_settings:read',
          'user_settings:write',
          'system_settings:read',
          'system_settings:write',
          'users:read',
          'users:write',
          'rbac:manage',
        ]),
        roles: new Set(['admin']),
        hasPermission: (perm: string) =>
          [
            'user_settings:read',
            'user_settings:write',
            'system_settings:read',
            'system_settings:write',
            'users:read',
            'users:write',
            'rbac:manage',
          ].includes(perm),
        hasAnyPermission: (...perms: string[]) =>
          perms.some((p) =>
            [
              'user_settings:read',
              'user_settings:write',
              'system_settings:read',
              'system_settings:write',
              'users:read',
              'users:write',
              'rbac:manage',
            ].includes(p)
          ),
        hasAllPermissions: (...perms: string[]) =>
          perms.every((p) =>
            [
              'user_settings:read',
              'user_settings:write',
              'system_settings:read',
              'system_settings:write',
              'users:read',
              'users:write',
              'rbac:manage',
            ].includes(p)
          ),
        hasRole: (role: string) => role === 'admin',
        hasAnyRole: (...roleList: string[]) => roleList.includes('admin'),
        isAdmin: true,
      });
    });

    it('should allow admin to access system settings', () => {
      render(
        <RequirePermission permission="system_settings:write">
          <div>System Configuration</div>
        </RequirePermission>
      );

      expect(screen.getByText('System Configuration')).toBeInTheDocument();
    });

    it('should allow admin to access user management', () => {
      render(
        <RequirePermission
          permissions={['users:read', 'users:write']}
          requireAll={true}
        >
          <div>User Administration</div>
        </RequirePermission>
      );

      expect(screen.getByText('User Administration')).toBeInTheDocument();
    });

    it('should allow admin role-based access', () => {
      render(
        <RequirePermission role="admin">
          <div>Admin Dashboard</div>
        </RequirePermission>
      );

      expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();
    });
  });

  describe('Real-World Use Cases', () => {
    it('should conditionally render edit button based on write permission', () => {
      render(
        <div>
          <div>User Profile</div>
          <RequirePermission permission="user_settings:write">
            <button>Edit Profile</button>
          </RequirePermission>
        </div>
      );

      expect(screen.getByText('User Profile')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /edit profile/i })).toBeInTheDocument();
    });

    it('should hide admin menu items for non-admin users', () => {
      render(
        <nav>
          <div>Home</div>
          <div>Settings</div>
          <RequirePermission role="admin">
            <div>Admin Panel</div>
          </RequirePermission>
        </nav>
      );

      expect(screen.getByText('Home')).toBeInTheDocument();
      expect(screen.getByText('Settings')).toBeInTheDocument();
      expect(screen.queryByText('Admin Panel')).not.toBeInTheDocument();
    });

    it('should show upgrade prompt when user lacks premium features', () => {
      render(
        <RequirePermission
          permission="premium:features"
          fallback={
            <div>
              <p>Upgrade to Premium</p>
              <button>Upgrade Now</button>
            </div>
          }
        >
          <div>Premium Content</div>
        </RequirePermission>
      );

      expect(screen.queryByText('Premium Content')).not.toBeInTheDocument();
      expect(screen.getByText('Upgrade to Premium')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /upgrade now/i })).toBeInTheDocument();
    });

    it('should allow contributors to create but not delete', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['posts:create', 'posts:read']),
        roles: new Set(['contributor']),
        hasPermission: (perm: string) =>
          perm === 'posts:create' || perm === 'posts:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: (role: string) => role === 'contributor',
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(
        <div>
          <RequirePermission permission="posts:create">
            <button>Create Post</button>
          </RequirePermission>
          <RequirePermission permission="posts:delete">
            <button>Delete Post</button>
          </RequirePermission>
        </div>
      );

      expect(screen.getByRole('button', { name: /create post/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /delete post/i })).not.toBeInTheDocument();
    });
  });
});
