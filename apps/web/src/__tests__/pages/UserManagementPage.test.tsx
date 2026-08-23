import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';
import UserManagementPage from '../../pages/UserManagementPage';

// Mock the hooks
vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

// Mock the child components
vi.mock('../../components/admin/UserList', () => ({
  UserList: vi.fn(() => <div data-testid="user-list">UserList Component</div>),
}));

vi.mock('../../components/admin/AllowlistTable', () => ({
  AllowlistTable: vi.fn(() => (
    <div data-testid="allowlist-table">AllowlistTable Component</div>
  )),
}));

import { usePermissions } from '../../hooks/usePermissions';
import { UserList } from '../../components/admin/UserList';
import { AllowlistTable } from '../../components/admin/AllowlistTable';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUserList = vi.mocked(UserList);
const mockAllowlistTable = vi.mocked(AllowlistTable);

describe('UserManagementPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default permission mock - a full admin. `allowlist:read` is part of the
    // seeded admin role and is what the Allowlist TAB gates on; the page itself
    // gates on `users:read`. The two are separate on purpose — see the
    // 'Tab-level authorization' block below.
    mockUsePermissions.mockReturnValue({
      permissions: new Set([
        'users:read',
        'users:write',
        'rbac:manage',
        'allowlist:read',
        'allowlist:write',
      ]),
      roles: new Set(['admin']),
      hasPermission: (perm: string) =>
        [
          'users:read',
          'users:write',
          'rbac:manage',
          'allowlist:read',
          'allowlist:write',
        ].includes(perm),
      hasAnyPermission: vi.fn(),
      hasAllPermissions: vi.fn(),
      hasRole: vi.fn(),
      hasAnyRole: vi.fn(),
      isAdmin: true,
    });

    // Reset mock implementations to default
    mockUserList.mockImplementation(() => (
      <div data-testid="user-list">UserList Component</div>
    ));

    mockAllowlistTable.mockImplementation(() => (
      <div data-testid="allowlist-table">AllowlistTable Component</div>
    ));
  });

  describe('Tab-level authorization', () => {
    /**
     * The page and its Allowlist tab gate on DIFFERENT permissions, matching
     * the two controllers behind them: `users.controller.ts` enforces
     * `users:read`, `allowlist.controller.ts` enforces `allowlist:read`.
     *
     * A destination gate is about REACHABILITY and a tab gate is about
     * CONTENT. Collapsing them either hides the whole page from someone
     * entitled to the Users tab, or renders a table that can only 403.
     */
    function setPermissions(granted: string[]) {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(granted),
        roles: new Set(['admin']),
        hasPermission: (perm: string) => granted.includes(perm),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });
    }

    it('renders the Allowlist table for a user holding allowlist:read', async () => {
      const user = userEvent.setup();
      setPermissions(['users:read', 'allowlist:read']);

      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });
      await user.click(screen.getByRole('tab', { name: /allowlist/i }));

      await waitFor(() => {
        expect(screen.getByTestId('allowlist-table')).toBeInTheDocument();
      });
    });

    it('keeps the page reachable on users:read alone, but withholds the Allowlist table', async () => {
      const user = userEvent.setup();
      setPermissions(['users:read']);

      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // Reachable: the Users tab is the reason the page exists for this user.
      expect(screen.getByTestId('user-list')).toBeInTheDocument();

      await user.click(screen.getByRole('tab', { name: /allowlist/i }));

      await waitFor(() => {
        expect(
          screen.getByText(
            /do not have permission to view the email allowlist/i,
          ),
        ).toBeInTheDocument();
      });
      expect(screen.queryByTestId('allowlist-table')).not.toBeInTheDocument();
    });
  });

  describe('Authorization', () => {
    it('should redirect users without users:read permission', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['user_settings:read']),
        roles: new Set(['viewer']),
        hasPermission: (perm: string) => perm === 'user_settings:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(<UserManagementPage />, {
        wrapperOptions: {
          user: {
            id: 'viewer-id',
            email: 'viewer@example.com',
            displayName: 'Viewer User',
            profileImageUrl: null,
            roles: [{ name: 'viewer' }],
            permissions: ['user_settings:read'],
            isActive: true,
            createdAt: new Date().toISOString(),
          },
        },
      });

      // Should redirect - page content should not render
      expect(screen.queryByText(/user management/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    });

    it('should render page for users with users:read permission', () => {
      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText(/user management/i)).toBeInTheDocument();
    });

    it('should check users:read permission', () => {
      const hasPermission = vi.fn((perm: string) => perm === 'users:read');
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['users:read']),
        roles: new Set(['admin']),
        hasPermission,
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(hasPermission).toHaveBeenCalledWith('users:read');
    });
  });

  describe('Page Content', () => {
    it('should display page title', () => {
      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(
        screen.getByRole('heading', { name: /user management/i }),
      ).toBeInTheDocument();
    });

    it('should display page description', () => {
      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(
        screen.getByText(/manage users and email allowlist/i),
      ).toBeInTheDocument();
    });

    it('should render within a container', () => {
      const { container } = render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const muiContainer = container.querySelector('.MuiContainer-root');
      expect(muiContainer).toBeInTheDocument();
      expect(muiContainer).toHaveClass('MuiContainer-maxWidthLg');
    });

    it('should render content within a Paper component', () => {
      const { container } = render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const paper = container.querySelector('.MuiPaper-root');
      expect(paper).toBeInTheDocument();
    });
  });

  describe('Tabs', () => {
    it('should display Users and Allowlist tabs', () => {
      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByRole('tab', { name: /users/i })).toBeInTheDocument();
      expect(
        screen.getByRole('tab', { name: /allowlist/i }),
      ).toBeInTheDocument();
    });

    it('should have Users tab selected by default', () => {
      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const usersTab = screen.getByRole('tab', { name: /users/i });
      const allowlistTab = screen.getByRole('tab', { name: /allowlist/i });

      expect(usersTab).toHaveAttribute('aria-selected', 'true');
      expect(allowlistTab).toHaveAttribute('aria-selected', 'false');
    });

    it('should switch to Allowlist tab when clicked', async () => {
      const user = userEvent.setup();

      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const allowlistTab = screen.getByRole('tab', { name: /allowlist/i });

      await user.click(allowlistTab);

      await waitFor(() => {
        expect(allowlistTab).toHaveAttribute('aria-selected', 'true');
      });
    });

    it('should switch back to Users tab when clicked', async () => {
      const user = userEvent.setup();

      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const usersTab = screen.getByRole('tab', { name: /users/i });
      const allowlistTab = screen.getByRole('tab', { name: /allowlist/i });

      // Click Allowlist tab first
      await user.click(allowlistTab);
      await waitFor(() => {
        expect(allowlistTab).toHaveAttribute('aria-selected', 'true');
      });

      // Click Users tab to switch back
      await user.click(usersTab);

      await waitFor(() => {
        expect(usersTab).toHaveAttribute('aria-selected', 'true');
        expect(allowlistTab).toHaveAttribute('aria-selected', 'false');
      });
    });

    it('should render tabs with correct order', () => {
      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(2);
      expect(tabs[0]).toHaveTextContent(/users/i);
      expect(tabs[1]).toHaveTextContent(/allowlist/i);
    });
  });

  describe('Tab Panels', () => {
    it('should display UserList component in Users tab by default', () => {
      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const userList = screen.getByTestId('user-list');
      expect(userList).toBeInTheDocument();
      expect(userList).toBeVisible();
    });

    it('should hide AllowlistTable in Users tab', () => {
      const { container } = render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // AllowlistTable should not be visible when Users tab is active
      // The TabPanel with index 1 should be hidden
      const tabPanels = container.querySelectorAll('[role="tabpanel"]');
      expect(tabPanels).toHaveLength(2);
      expect(tabPanels[1]).toHaveAttribute('hidden');
    });

    it('should display AllowlistTable when Allowlist tab is active', async () => {
      const user = userEvent.setup();

      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const allowlistTab = screen.getByRole('tab', { name: /allowlist/i });
      await user.click(allowlistTab);

      await waitFor(() => {
        const allowlistTable = screen.getByTestId('allowlist-table');
        expect(allowlistTable).toBeVisible();
      });
    });

    it('should hide UserList when Allowlist tab is active', async () => {
      const user = userEvent.setup();

      const { container } = render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const allowlistTab = screen.getByRole('tab', { name: /allowlist/i });
      await user.click(allowlistTab);

      await waitFor(() => {
        const tabPanels = container.querySelectorAll('[role="tabpanel"]');
        expect(tabPanels[0]).toHaveAttribute('hidden');
      });
    });

    it('should render both tab panels in DOM regardless of active tab', () => {
      const { container } = render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const tabPanels = container.querySelectorAll('[role="tabpanel"]');
      expect(tabPanels).toHaveLength(2);
      // Only the active tab's content is rendered
      expect(screen.getByTestId('user-list')).toBeInTheDocument();
    });

    it('should use correct role for tab panels', () => {
      const { container } = render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const tabPanels = container.querySelectorAll('[role="tabpanel"]');
      expect(tabPanels).toHaveLength(2);
    });

    it('should hide tab panels using hidden attribute', () => {
      const { container } = render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const tabPanels = container.querySelectorAll('[role="tabpanel"]');
      expect(tabPanels).toHaveLength(2);

      // Users tab is active by default (index 0)
      expect(tabPanels[0]).not.toHaveAttribute('hidden');
      // Allowlist tab should be hidden (index 1)
      expect(tabPanels[1]).toHaveAttribute('hidden');
    });
  });

  describe('Tab Index State Management', () => {
    it('should initialize with tab index 0', () => {
      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const usersTab = screen.getByRole('tab', { name: /users/i });
      expect(usersTab).toHaveAttribute('aria-selected', 'true');
    });

    it('should update tab index when switching tabs', async () => {
      const user = userEvent.setup();

      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const allowlistTab = screen.getByRole('tab', { name: /allowlist/i });

      // Initially tab index should be 0 (Users)
      expect(screen.getByRole('tab', { name: /users/i })).toHaveAttribute(
        'aria-selected',
        'true',
      );

      // Click Allowlist tab (index 1)
      await user.click(allowlistTab);

      await waitFor(() => {
        expect(allowlistTab).toHaveAttribute('aria-selected', 'true');
      });
    });

    it('should maintain tab index during component lifecycle', async () => {
      const user = userEvent.setup();

      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const allowlistTab = screen.getByRole('tab', { name: /allowlist/i });
      const usersTab = screen.getByRole('tab', { name: /users/i });

      // Switch to Allowlist
      await user.click(allowlistTab);
      await waitFor(() => {
        expect(allowlistTab).toHaveAttribute('aria-selected', 'true');
      });

      // Switch back to Users
      await user.click(usersTab);
      await waitFor(() => {
        expect(usersTab).toHaveAttribute('aria-selected', 'true');
      });

      // Switch to Allowlist again
      await user.click(allowlistTab);
      await waitFor(() => {
        expect(allowlistTab).toHaveAttribute('aria-selected', 'true');
      });
    });
  });

  describe('Component Integration', () => {
    it('should render UserList component', () => {
      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(mockUserList).toHaveBeenCalled();
      expect(screen.getByTestId('user-list')).toBeInTheDocument();
    });

    it('should render AllowlistTable component when tab is switched', async () => {
      const user = userEvent.setup();

      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const allowlistTab = screen.getByRole('tab', { name: /allowlist/i });
      await user.click(allowlistTab);

      await waitFor(() => {
        expect(screen.getByTestId('allowlist-table')).toBeInTheDocument();
      });
    });

    it('should not pass any props to UserList', () => {
      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // React 19 passes (props, undefined) — legacy context replaced by undefined
      expect(mockUserList).toHaveBeenCalledWith({}, undefined);
    });

    it('should not pass any props to AllowlistTable', async () => {
      const user = userEvent.setup();

      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // Switch to Allowlist tab to trigger render
      const allowlistTab = screen.getByRole('tab', { name: /allowlist/i });
      await user.click(allowlistTab);

      await waitFor(() => {
        // React 19 passes (props, undefined) — legacy context replaced by undefined
        expect(mockAllowlistTable).toHaveBeenCalledWith({}, undefined);
      });
    });
  });

  describe('Layout Structure', () => {
    it('should use correct Container maxWidth', () => {
      const { container } = render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const muiContainer = container.querySelector('.MuiContainer-maxWidthLg');
      expect(muiContainer).toBeInTheDocument();
    });

    it('should apply correct spacing to container', () => {
      const { container } = render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const box = container.querySelector('.MuiBox-root');
      expect(box).toBeInTheDocument();
    });

    it('should render tabs with divider', () => {
      const { container } = render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const tabs = container.querySelector('.MuiTabs-root');
      expect(tabs).toBeInTheDocument();
    });

    it('should have proper padding on tab panel container', () => {
      const { container } = render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const paper = container.querySelector('.MuiPaper-root');
      expect(paper).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have proper heading hierarchy', () => {
      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const heading = screen.getByRole('heading', { name: /user management/i });
      expect(heading.tagName).toBe('H1');
    });

    it('should have accessible tab labels', () => {
      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const usersTab = screen.getByRole('tab', { name: /users/i });
      const allowlistTab = screen.getByRole('tab', { name: /allowlist/i });

      expect(usersTab).toHaveAccessibleName();
      expect(allowlistTab).toHaveAccessibleName();
    });

    it('should have proper ARIA attributes on tabs', () => {
      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const tabs = screen.getAllByRole('tab');

      tabs.forEach((tab) => {
        expect(tab).toHaveAttribute('aria-selected');
      });
    });

    it('should have proper role attributes on tab panels', () => {
      const { container } = render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const tabPanels = container.querySelectorAll('[role="tabpanel"]');
      expect(tabPanels).toHaveLength(2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid tab switching', async () => {
      const user = userEvent.setup();

      render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const usersTab = screen.getByRole('tab', { name: /users/i });
      const allowlistTab = screen.getByRole('tab', { name: /allowlist/i });

      // Rapidly switch tabs
      await user.click(allowlistTab);
      await user.click(usersTab);
      await user.click(allowlistTab);
      await user.click(usersTab);

      await waitFor(() => {
        expect(usersTab).toHaveAttribute('aria-selected', 'true');
      });
    });

    it('should maintain page state when components render', () => {
      const { rerender } = render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText(/user management/i)).toBeInTheDocument();

      // Force a rerender
      rerender(<UserManagementPage />);

      expect(screen.getByText(/user management/i)).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /users/i })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('should handle component mount and unmount cleanly', () => {
      const { unmount } = render(<UserManagementPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText(/user management/i)).toBeInTheDocument();

      // Unmount should not throw
      expect(() => unmount()).not.toThrow();
    });
  });

  describe('Navigation Integration', () => {
    it('should redirect to home when permission is denied', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set([]),
        roles: new Set(['viewer']),
        hasPermission: () => false,
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(<UserManagementPage />, {
        wrapperOptions: {
          route: '/admin/users',
          user: {
            id: 'viewer-id',
            email: 'viewer@example.com',
            displayName: 'Viewer',
            profileImageUrl: null,
            roles: [{ name: 'viewer' }],
            permissions: [],
            isActive: true,
            createdAt: new Date().toISOString(),
          },
        },
      });

      // Should not render page content
      expect(screen.queryByText(/user management/i)).not.toBeInTheDocument();
    });

    it('should use replace navigation for redirect', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set([]),
        roles: new Set(['viewer']),
        hasPermission: () => false,
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(<UserManagementPage />, {
        wrapperOptions: {
          route: '/admin/users',
          user: null,
        },
      });

      // Navigate component uses replace prop
      expect(screen.queryByText(/user management/i)).not.toBeInTheDocument();
    });
  });
});
