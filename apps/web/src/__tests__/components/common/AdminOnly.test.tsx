import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render, mockAdminUser, mockUser } from '../../utils/test-utils';
import { AdminOnly } from '../../../components/common/AdminOnly';

describe('AdminOnly', () => {
  describe('Admin Users', () => {
    it('should render children when user is admin', () => {
      render(
        <AdminOnly>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockAdminUser,
          },
        }
      );

      expect(screen.getByText('Admin Content')).toBeInTheDocument();
    });

    it('should render complex children when user is admin', () => {
      render(
        <AdminOnly>
          <div>
            <h1>Admin Dashboard</h1>
            <p>Welcome, administrator</p>
            <button>Manage Users</button>
          </div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockAdminUser,
          },
        }
      );

      expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();
      expect(screen.getByText('Welcome, administrator')).toBeInTheDocument();
      expect(screen.getByText('Manage Users')).toBeInTheDocument();
    });

    it('should render multiple child elements when user is admin', () => {
      render(
        <AdminOnly>
          <div>First Element</div>
          <div>Second Element</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockAdminUser,
          },
        }
      );

      expect(screen.getByText('First Element')).toBeInTheDocument();
      expect(screen.getByText('Second Element')).toBeInTheDocument();
    });

    it('should render string children when user is admin', () => {
      render(
        <AdminOnly>Admin Only Text</AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockAdminUser,
          },
        }
      );

      expect(screen.getByText('Admin Only Text')).toBeInTheDocument();
    });
  });

  describe('Non-Admin Users', () => {
    it('should not render children when user is not admin', () => {
      render(
        <AdminOnly>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockUser, // viewer role
          },
        }
      );

      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
    });

    it('should not render children when user is contributor', () => {
      const contributorUser = {
        ...mockUser,
        roles: [{ name: 'contributor' }],
        permissions: ['user_settings:read', 'user_settings:write'],
      };

      render(
        <AdminOnly>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: contributorUser,
          },
        }
      );

      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
    });

    it('should not render children when user is viewer', () => {
      const viewerUser = {
        ...mockUser,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read', 'user_settings:write'],
      };

      render(
        <AdminOnly>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: viewerUser,
          },
        }
      );

      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
    });
  });

  describe('Fallback Rendering', () => {
    it('should render fallback when user is not admin', () => {
      render(
        <AdminOnly fallback={<div>Access Denied</div>}>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockUser,
          },
        }
      );

      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
      expect(screen.getByText('Access Denied')).toBeInTheDocument();
    });

    it('should render complex fallback when user is not admin', () => {
      render(
        <AdminOnly
          fallback={
            <div>
              <h2>Insufficient Permissions</h2>
              <p>You need administrator privileges to view this content.</p>
            </div>
          }
        >
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockUser,
          },
        }
      );

      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
      expect(screen.getByText('Insufficient Permissions')).toBeInTheDocument();
      expect(
        screen.getByText('You need administrator privileges to view this content.')
      ).toBeInTheDocument();
    });

    it('should not render fallback when user is admin', () => {
      render(
        <AdminOnly fallback={<div>Access Denied</div>}>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockAdminUser,
          },
        }
      );

      expect(screen.getByText('Admin Content')).toBeInTheDocument();
      expect(screen.queryByText('Access Denied')).not.toBeInTheDocument();
    });

    it('should render string fallback when user is not admin', () => {
      render(
        <AdminOnly fallback="Access Denied">
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockUser,
          },
        }
      );

      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
      expect(screen.getByText('Access Denied')).toBeInTheDocument();
    });
  });

  describe('Null Fallback', () => {
    it('should render nothing when fallback is null and user is not admin', () => {
      const { container } = render(
        <AdminOnly fallback={null}>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockUser,
          },
        }
      );

      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
      // Fragment renders nothing when empty
      expect(container.textContent).toBe('');
    });

    it('should render nothing when fallback is undefined and user is not admin', () => {
      const { container } = render(
        <AdminOnly fallback={undefined}>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockUser,
          },
        }
      );

      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
      expect(container.textContent).toBe('');
    });

    it('should render nothing when no fallback provided and user is not admin', () => {
      const { container } = render(
        <AdminOnly>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockUser,
          },
        }
      );

      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
      expect(container.textContent).toBe('');
    });
  });

  describe('Edge Cases', () => {
    it('should hide content when user is unauthenticated', () => {
      render(
        <AdminOnly>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: false,
            user: null,
          },
        }
      );

      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
    });

    it('should render fallback when user is unauthenticated', () => {
      render(
        <AdminOnly fallback={<div>Please log in</div>}>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: false,
            user: null,
          },
        }
      );

      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
      expect(screen.getByText('Please log in')).toBeInTheDocument();
    });

    it('should handle user with multiple roles including admin', () => {
      const multiRoleUser = {
        ...mockAdminUser,
        roles: [{ name: 'admin' }, { name: 'contributor' }, { name: 'viewer' }],
      };

      render(
        <AdminOnly>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: multiRoleUser,
          },
        }
      );

      expect(screen.getByText('Admin Content')).toBeInTheDocument();
    });

    it('should handle user with multiple non-admin roles', () => {
      const multiRoleUser = {
        ...mockUser,
        roles: [{ name: 'contributor' }, { name: 'viewer' }],
      };

      render(
        <AdminOnly>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: multiRoleUser,
          },
        }
      );

      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
    });

    it('should handle user with empty roles array', () => {
      const noRolesUser = {
        ...mockUser,
        roles: [],
      };

      render(
        <AdminOnly>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: noRolesUser,
          },
        }
      );

      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
    });

    it('should handle user with null in data', () => {
      const nullDataUser = {
        ...mockUser,
        displayName: null,
        profileImageUrl: null,
      };

      render(
        <AdminOnly fallback={<div>Not Admin</div>}>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: nullDataUser,
          },
        }
      );

      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
      expect(screen.getByText('Not Admin')).toBeInTheDocument();
    });

    it('should handle inactive admin user', () => {
      const inactiveAdminUser = {
        ...mockAdminUser,
        isActive: false,
      };

      render(
        <AdminOnly>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: inactiveAdminUser,
          },
        }
      );

      // Component only checks isAdmin, not isActive
      expect(screen.getByText('Admin Content')).toBeInTheDocument();
    });
  });

  describe('Content Visibility', () => {
    it('should completely hide sensitive admin content from non-admins', () => {
      const { container } = render(
        <AdminOnly>
          <div data-testid="sensitive-data">
            <input type="password" value="secret" readOnly />
            <div>Confidential Information</div>
          </div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockUser,
          },
        }
      );

      expect(screen.queryByTestId('sensitive-data')).not.toBeInTheDocument();
      expect(screen.queryByText('Confidential Information')).not.toBeInTheDocument();
      expect(screen.queryByDisplayValue('secret')).not.toBeInTheDocument();
      // Ensure nothing is rendered
      expect(container.textContent).toBe('');
    });

    it('should show all sensitive content to admins', () => {
      render(
        <AdminOnly>
          <div data-testid="sensitive-data">
            <input type="password" value="secret" readOnly />
            <div>Confidential Information</div>
          </div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockAdminUser,
          },
        }
      );

      expect(screen.getByTestId('sensitive-data')).toBeInTheDocument();
      expect(screen.getByText('Confidential Information')).toBeInTheDocument();
      expect(screen.getByDisplayValue('secret')).toBeInTheDocument();
    });
  });

  describe('React Fragment Behavior', () => {
    it('should return React Fragment containing children for admin', () => {
      const { container } = render(
        <AdminOnly>
          <div>Content 1</div>
          <div>Content 2</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockAdminUser,
          },
        }
      );

      expect(screen.getByText('Content 1')).toBeInTheDocument();
      expect(screen.getByText('Content 2')).toBeInTheDocument();
      // Both elements should be in the container
      expect(container.querySelectorAll('div').length).toBeGreaterThanOrEqual(2);
    });

    it('should return React Fragment containing fallback for non-admin', () => {
      render(
        <AdminOnly fallback={<div>Fallback Content</div>}>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockUser,
          },
        }
      );

      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
      expect(screen.getByText('Fallback Content')).toBeInTheDocument();
    });

    it('should return empty React Fragment when no fallback and non-admin', () => {
      const { container } = render(
        <div data-testid="wrapper">
          <AdminOnly>
            <div>Admin Content</div>
          </AdminOnly>
        </div>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockUser,
          },
        }
      );

      const wrapper = screen.getByTestId('wrapper');
      expect(wrapper.textContent).toBe('');
      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
    });
  });

  describe('Use Cases', () => {
    it('should work with navigation links', () => {
      render(
        <AdminOnly>
          <a href="/admin">Admin Panel</a>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockAdminUser,
          },
        }
      );

      const link = screen.getByText('Admin Panel');
      expect(link).toBeInTheDocument();
      expect(link.getAttribute('href')).toBe('/admin');
    });

    it('should work with buttons', () => {
      render(
        <AdminOnly fallback={<button disabled>Locked</button>}>
          <button>Delete User</button>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockUser,
          },
        }
      );

      expect(screen.queryByText('Delete User')).not.toBeInTheDocument();
      expect(screen.getByText('Locked')).toBeInTheDocument();
    });

    it('should work with conditional admin sections in pages', () => {
      render(
        <div>
          <h1>User Profile</h1>
          <div>Public Information</div>
          <AdminOnly>
            <div>Admin Controls</div>
            <button>Ban User</button>
          </AdminOnly>
        </div>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockUser,
          },
        }
      );

      expect(screen.getByText('User Profile')).toBeInTheDocument();
      expect(screen.getByText('Public Information')).toBeInTheDocument();
      expect(screen.queryByText('Admin Controls')).not.toBeInTheDocument();
      expect(screen.queryByText('Ban User')).not.toBeInTheDocument();
    });

    it('should work with nested admin-only components', () => {
      render(
        <AdminOnly>
          <div>
            Admin Section
            <AdminOnly>
              <div>Nested Admin Content</div>
            </AdminOnly>
          </div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockAdminUser,
          },
        }
      );

      expect(screen.getByText('Admin Section')).toBeInTheDocument();
      expect(screen.getByText('Nested Admin Content')).toBeInTheDocument();
    });
  });

  describe('Performance', () => {
    it('should handle rapid re-renders', () => {
      const { rerender } = render(
        <AdminOnly>
          <div>Admin Content</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockAdminUser,
          },
        }
      );

      expect(screen.getByText('Admin Content')).toBeInTheDocument();

      // Rerender with non-admin user
      rerender(
        <AdminOnly>
          <div>Admin Content</div>
        </AdminOnly>
      );

      // Content should still be rendered (since we didn't change the wrapper)
      expect(screen.getByText('Admin Content')).toBeInTheDocument();
    });

    it('should handle dynamic children', () => {
      const { rerender } = render(
        <AdminOnly>
          <div>Content 1</div>
        </AdminOnly>,
        {
          wrapperOptions: {
            authenticated: true,
            user: mockAdminUser,
          },
        }
      );

      expect(screen.getByText('Content 1')).toBeInTheDocument();

      rerender(
        <AdminOnly>
          <div>Content 2</div>
        </AdminOnly>
      );

      expect(screen.queryByText('Content 1')).not.toBeInTheDocument();
      expect(screen.getByText('Content 2')).toBeInTheDocument();
    });
  });
});
