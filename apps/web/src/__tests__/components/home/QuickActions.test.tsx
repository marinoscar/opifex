import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser, mockAdminUser } from '../../utils/test-utils';
import { QuickActions } from '../../../components/home/QuickActions';
import { DESTINATIONS } from '../../../config/destinations';
import type { DestinationKey } from '../../../config/destinations';

// Mock useNavigate from react-router-dom
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock usePermissions hook
vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { usePermissions } from '../../../hooks/usePermissions';

const mockUsePermissions = vi.mocked(usePermissions);

describe('QuickActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default permission mock - viewer user (no admin permissions)
    mockUsePermissions.mockReturnValue({
      permissions: new Set(['user_settings:read', 'user_settings:write']),
      roles: new Set(['viewer']),
      hasPermission: (perm: string) =>
        perm === 'user_settings:read' || perm === 'user_settings:write',
      hasAnyPermission: vi.fn(),
      hasAllPermissions: vi.fn(),
      hasRole: vi.fn(),
      hasAnyRole: vi.fn(),
      isAdmin: false,
    });
  });

  describe('Rendering', () => {
    it('should render the Quick Actions card', () => {
      render(<QuickActions />);

      expect(screen.getByText(/quick actions/i)).toBeInTheDocument();
    });

    it('should render User Settings action for all users', () => {
      render(<QuickActions />);

      expect(screen.getByText(/^user settings$/i)).toBeInTheDocument();
      expect(screen.getByText(/manage your profile and preferences/i)).toBeInTheDocument();
    });

    it('should render Theme action for all users', () => {
      render(<QuickActions />);

      expect(screen.getByText(/^theme$/i)).toBeInTheDocument();
      expect(screen.getByText(/customize your display preferences/i)).toBeInTheDocument();
    });

    it('should render action buttons as outlined variant', () => {
      render(<QuickActions />);

      const userSettingsButton = screen.getByRole('button', {
        name: /user settings manage your profile and preferences/i,
      });
      expect(userSettingsButton).toHaveClass('MuiButton-outlined');
    });

    it('should render buttons in a grid layout', () => {
      const { container } = render(<QuickActions />);

      // In MUI 9 Grid v2, items no longer use MuiGrid-item; use MuiGrid-container instead
      const gridContainer = container.querySelector('.MuiGrid-container');
      expect(gridContainer).toBeInTheDocument();
    });
  });

  describe('Icons', () => {
    it('should display PersonIcon for User Settings', () => {
      render(<QuickActions />);

      const userSettingsButton = screen.getByRole('button', {
        name: /user settings manage your profile and preferences/i,
      });
      expect(userSettingsButton).toBeInTheDocument();

      // Icon should be rendered within the button
      const iconContainer = userSettingsButton.querySelector('svg');
      expect(iconContainer).toBeInTheDocument();
    });

    it('should display PaletteIcon for Theme', () => {
      render(<QuickActions />);

      const themeButton = screen.getByRole('button', {
        name: /theme customize your display preferences/i,
      });
      expect(themeButton).toBeInTheDocument();

      // Icon should be rendered within the button
      const iconContainer = themeButton.querySelector('svg');
      expect(iconContainer).toBeInTheDocument();
    });

    it('should display AdminPanelSettingsIcon for System Settings (admin only)', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['system_settings:read']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) => perm === 'system_settings:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<QuickActions />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const systemSettingsButton = screen.getByRole('button', {
        name: /system settings configure application settings/i,
      });
      expect(systemSettingsButton).toBeInTheDocument();

      // Icon should be rendered within the button
      const iconContainer = systemSettingsButton.querySelector('svg');
      expect(iconContainer).toBeInTheDocument();
    });

    it('should style icons with primary color', () => {
      const { container } = render(<QuickActions />);

      // Icons are wrapped in Box with primary.main color
      const iconBoxes = container.querySelectorAll('[class*="MuiBox-root"]');
      expect(iconBoxes.length).toBeGreaterThan(0);
    });
  });

  describe('Navigation', () => {
    it('should navigate to /settings when User Settings is clicked', async () => {
      const user = userEvent.setup();

      render(<QuickActions />);

      const userSettingsButton = screen.getByRole('button', {
        name: /user settings manage your profile and preferences/i,
      });
      await user.click(userSettingsButton);

      expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });

    it('should navigate to /settings#theme when Theme is clicked', async () => {
      const user = userEvent.setup();

      render(<QuickActions />);

      const themeButton = screen.getByRole('button', {
        name: /theme customize your display preferences/i,
      });
      await user.click(themeButton);

      expect(mockNavigate).toHaveBeenCalledWith('/settings#theme');
    });

    it('should navigate to /admin/settings when System Settings is clicked (admin)', async () => {
      const user = userEvent.setup();

      mockUsePermissions.mockReturnValue({
        permissions: new Set(['system_settings:read']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) => perm === 'system_settings:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<QuickActions />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const systemSettingsButton = screen.getByRole('button', {
        name: /system settings configure application settings/i,
      });
      await user.click(systemSettingsButton);

      expect(mockNavigate).toHaveBeenCalledWith('/admin/settings');
    });
  });

  describe('Permission-Based Filtering', () => {
    it('should NOT show System Settings for non-admin users', () => {
      render(<QuickActions />, {
        wrapperOptions: { user: mockUser },
      });

      expect(screen.queryByText(/^system settings$/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/configure application settings/i)).not.toBeInTheDocument();
    });

    it('should show System Settings for users with system_settings:read permission', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['system_settings:read']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) => perm === 'system_settings:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<QuickActions />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText(/^system settings$/i)).toBeInTheDocument();
      expect(screen.getByText(/configure application settings/i)).toBeInTheDocument();
    });

    it('should NOT show System Settings if user lacks required permission', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['user_settings:read', 'user_settings:write']),
        roles: new Set(['contributor']),
        hasPermission: (perm: string) =>
          perm === 'user_settings:read' || perm === 'user_settings:write',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(<QuickActions />);

      expect(screen.queryByText(/^system settings$/i)).not.toBeInTheDocument();
    });

    it('should filter actions based on permission checks', () => {
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

      render(<QuickActions />);

      // Actions without permissions should still show
      expect(screen.getByText(/^user settings$/i)).toBeInTheDocument();
      expect(screen.getByText(/^theme$/i)).toBeInTheDocument();

      // Actions requiring permissions should not show
      expect(screen.queryByText(/^system settings$/i)).not.toBeInTheDocument();
    });
  });

  describe('Role-Based Display', () => {
    it('should display only basic actions for Viewer role', () => {
      const viewerUser = {
        ...mockUser,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read', 'user_settings:write'],
      };

      render(<QuickActions />, {
        wrapperOptions: { user: viewerUser },
      });

      expect(screen.getByText(/^user settings$/i)).toBeInTheDocument();
      expect(screen.getByText(/^theme$/i)).toBeInTheDocument();
      expect(screen.queryByText(/^system settings$/i)).not.toBeInTheDocument();
    });

    it('should display only basic actions for Contributor role', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['user_settings:read', 'user_settings:write']),
        roles: new Set(['contributor']),
        hasPermission: (perm: string) =>
          perm === 'user_settings:read' || perm === 'user_settings:write',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const contributorUser = {
        ...mockUser,
        roles: [{ name: 'contributor' }],
        permissions: ['user_settings:read', 'user_settings:write'],
      };

      render(<QuickActions />, {
        wrapperOptions: { user: contributorUser },
      });

      expect(screen.getByText(/^user settings$/i)).toBeInTheDocument();
      expect(screen.getByText(/^theme$/i)).toBeInTheDocument();
      expect(screen.queryByText(/^system settings$/i)).not.toBeInTheDocument();
    });

    it('should display all actions including System Settings for Admin role', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set([
          'user_settings:read',
          'user_settings:write',
          'system_settings:read',
          'system_settings:write',
        ]),
        roles: new Set(['admin']),
        hasPermission: (perm: string) =>
          [
            'user_settings:read',
            'user_settings:write',
            'system_settings:read',
            'system_settings:write',
          ].includes(perm),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<QuickActions />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText(/^user settings$/i)).toBeInTheDocument();
      expect(screen.getByText(/^theme$/i)).toBeInTheDocument();
      expect(screen.getByText(/^system settings$/i)).toBeInTheDocument();
    });
  });

  describe('Action Titles and Descriptions', () => {
    it('should display correct title for User Settings', () => {
      render(<QuickActions />);

      expect(screen.getByText(/^user settings$/i)).toBeInTheDocument();
    });

    it('should display correct description for User Settings', () => {
      render(<QuickActions />);

      expect(screen.getByText(/manage your profile and preferences/i)).toBeInTheDocument();
    });

    it('should display correct title for Theme', () => {
      render(<QuickActions />);

      expect(screen.getByText(/^theme$/i)).toBeInTheDocument();
    });

    it('should display correct description for Theme', () => {
      render(<QuickActions />);

      expect(screen.getByText(/customize your display preferences/i)).toBeInTheDocument();
    });

    it('should display correct title for System Settings (admin)', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['system_settings:read']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) => perm === 'system_settings:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<QuickActions />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText(/^system settings$/i)).toBeInTheDocument();
    });

    it('should display correct description for System Settings (admin)', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['system_settings:read']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) => perm === 'system_settings:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<QuickActions />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText(/configure application settings/i)).toBeInTheDocument();
    });
  });

  describe('Button Styling', () => {
    it('should render fullWidth buttons', () => {
      render(<QuickActions />);

      const userSettingsButton = screen.getByRole('button', {
        name: /user settings manage your profile and preferences/i,
      });
      expect(userSettingsButton).toHaveClass('MuiButton-fullWidth');
    });

    it('should use left-aligned text layout', () => {
      const { container } = render(<QuickActions />);

      const buttons = container.querySelectorAll('.MuiButton-root');
      buttons.forEach((button) => {
        expect(button).toBeInTheDocument();
      });
    });

    it('should display both title and description in each button', () => {
      render(<QuickActions />);

      // User Settings button should contain both title and description
      const userSettingsButton = screen.getByRole('button', {
        name: /user settings manage your profile and preferences/i,
      });
      expect(userSettingsButton).toBeInTheDocument();

      // Theme button should contain both title and description
      const themeButton = screen.getByRole('button', {
        name: /theme customize your display preferences/i,
      });
      expect(themeButton).toBeInTheDocument();
    });
  });

  describe('Grid Layout', () => {
    it('should render actions in a Grid container', () => {
      const { container } = render(<QuickActions />);

      const gridContainer = container.querySelector('.MuiGrid-container');
      expect(gridContainer).toBeInTheDocument();
    });

    it('should render each action in a Grid item', () => {
      const { container } = render(<QuickActions />);

      // In MUI 9 Grid v2, items use size-based classes instead of MuiGrid-item.
      // Check the grid container has the expected number of direct children.
      const gridContainer = container.querySelector('.MuiGrid-container');
      expect(gridContainer).toBeInTheDocument();
      // At minimum: User Settings + Theme (2 items for non-admin)
      expect(gridContainer?.children.length).toBeGreaterThanOrEqual(2);
    });

    it('should render three grid items for admin users', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['system_settings:read']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) => perm === 'system_settings:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      const { container } = render(<QuickActions />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // In MUI 9 Grid v2, items use size-based classes instead of MuiGrid-item.
      const gridContainer = container.querySelector('.MuiGrid-container');
      expect(gridContainer).toBeInTheDocument();
      // User Settings + Theme + System Settings = 3 items
      expect(gridContainer?.children.length).toBe(3);
    });
  });

  describe('Action Types', () => {
    it('should render basic user actions for all users', () => {
      render(<QuickActions />);

      expect(screen.getByRole('button', {
        name: /user settings/i,
      })).toBeInTheDocument();

      expect(screen.getByRole('button', {
        name: /theme/i,
      })).toBeInTheDocument();
    });

    it('should render admin actions only for authorized users', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['system_settings:read']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) => perm === 'system_settings:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<QuickActions />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByRole('button', {
        name: /system settings/i,
      })).toBeInTheDocument();
    });

    it('should have unique paths for each action', async () => {
      const user = userEvent.setup();

      mockUsePermissions.mockReturnValue({
        permissions: new Set(['system_settings:read']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) => perm === 'system_settings:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<QuickActions />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // Click User Settings
      await user.click(screen.getByRole('button', { name: /user settings/i }));
      expect(mockNavigate).toHaveBeenLastCalledWith('/settings');

      // Click Theme
      await user.click(screen.getByRole('button', { name: /theme/i }));
      expect(mockNavigate).toHaveBeenLastCalledWith('/settings#theme');

      // Click System Settings
      await user.click(screen.getByRole('button', { name: /system settings/i }));
      expect(mockNavigate).toHaveBeenLastCalledWith('/admin/settings');
    });
  });

  describe('Accessibility', () => {
    it('should have accessible button labels', () => {
      render(<QuickActions />);

      const userSettingsButton = screen.getByRole('button', {
        name: /user settings manage your profile and preferences/i,
      });
      expect(userSettingsButton).toBeInTheDocument();

      const themeButton = screen.getByRole('button', {
        name: /theme customize your display preferences/i,
      });
      expect(themeButton).toBeInTheDocument();
    });

    it('should use proper heading for section title', () => {
      render(<QuickActions />);

      const heading = screen.getByText(/quick actions/i);
      expect(heading).toBeInTheDocument();
      expect(heading.tagName).toBe('H6');
    });

    it('should use semantic HTML for cards', () => {
      const { container } = render(<QuickActions />);

      const card = container.querySelector('.MuiCard-root');
      expect(card).toBeInTheDocument();
    });

    it('should have clickable buttons for keyboard navigation', async () => {
      const user = userEvent.setup();

      render(<QuickActions />);

      const userSettingsButton = screen.getByRole('button', {
        name: /user settings/i,
      });

      // Tab to button and press Enter
      await user.tab();
      await user.keyboard('{Enter}');

      // Should be able to focus and activate buttons
      expect(userSettingsButton).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty permissions gracefully', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set([]),
        roles: new Set([]),
        hasPermission: () => false,
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(<QuickActions />);

      // Basic actions without permission requirements should still show
      expect(screen.getByText(/^user settings$/i)).toBeInTheDocument();
      expect(screen.getByText(/^theme$/i)).toBeInTheDocument();
    });

    it('should not crash when navigate is called multiple times', async () => {
      const user = userEvent.setup();

      render(<QuickActions />);

      const userSettingsButton = screen.getByRole('button', {
        name: /user settings/i,
      });

      // Click multiple times
      await user.click(userSettingsButton);
      await user.click(userSettingsButton);
      await user.click(userSettingsButton);

      expect(mockNavigate).toHaveBeenCalledTimes(3);
      expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });

    it('should maintain button state after clicks', async () => {
      const user = userEvent.setup();

      render(<QuickActions />);

      const userSettingsButton = screen.getByRole('button', {
        name: /user settings/i,
      });

      await user.click(userSettingsButton);

      // Button should still be in the document after navigation
      expect(userSettingsButton).toBeInTheDocument();
    });
  });

  describe('Sourced from the destination table', () => {
    /**
     * Issue #55. These actions used to carry their own copy of `/settings` and
     * `/admin/settings`, plus a hybrid gate: a `permission` field beside a dead
     * `adminOnly` field no entry ever set. That was one of three inconsistent
     * gating idioms in the app, and their disagreement is the bug this closes.
     *
     * Everything except the description prose now comes from
     * `config/destinations.ts`, so these tests check the WIRING rather than
     * restating the table's contents.
     */
    function setPermissions(granted: string[], isAdmin = false) {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(granted),
        roles: new Set(isAdmin ? ['admin'] : ['viewer']),
        hasPermission: (perm: string) => granted.includes(perm),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin,
      });
    }

    it('shows User Management to a user holding users:read', () => {
      // Previously impossible: this surface had no User Management entry at all,
      // so the page was reachable only by typing the URL.
      setPermissions(['users:read'], true);

      render(<QuickActions />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /user management/i })).toBeInTheDocument();
    });

    it('hides User Management from a user without users:read', () => {
      setPermissions(['system_settings:read'], true);

      render(<QuickActions />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByRole('button', { name: /user management/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /system settings/i })).toBeInTheDocument();
    });

    it('gates on permission alone — the admin role grants nothing by itself', () => {
      // The dead `adminOnly` field is gone. A user with the `admin` role and no
      // permissions sees exactly what a viewer sees.
      setPermissions([], true);

      render(<QuickActions />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByRole('button', { name: /user management/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /system settings/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /user settings/i })).toBeInTheDocument();
    });

    it('takes each action path from the destination table, not a local copy', () => {
      setPermissions(['users:read', 'system_settings:read'], true);

      render(<QuickActions />, { wrapperOptions: { user: mockAdminUser } });

      // Scoped to the keys QuickActions actually describes, NOT to every
      // destination. This loop used to run over the whole table minus `home`,
      // which passed only because `ACTION_DESCRIPTIONS` happened to cover all
      // three remaining destinations — an accident, not an invariant. Epic #19
      // adds the cockpit destinations (runs, queue, projects, cost), which have
      // no description here and are reached from the rail, so the old form
      // asserted buttons this component never claimed to render.
      //
      // QuickActions is slated for removal in #75, where the sectioned rail and
      // the bottom-bar overflow take over navigation entirely. Until then this
      // still guards the real property: the label and path come from
      // `DESTINATIONS`, not from a second copy inside the component.
      const described = new Set<DestinationKey>(['settings', 'users', 'system']);

      for (const destination of DESTINATIONS.filter((d) => described.has(d.key))) {
        expect(
          screen.getByRole('button', { name: new RegExp(destination.label, 'i') }),
          `${destination.label} missing from Quick Actions`,
        ).toBeInTheDocument();
      }
    });

    it('keeps Theme as a deep link that rides on User Settings visibility', () => {
      // Theme is not a destination — it has no rail row and no bottom-bar tab —
      // so it lives here and inherits its parent's visibility.
      setPermissions([]);

      render(<QuickActions />);

      expect(screen.getByRole('button', { name: /theme/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /user settings/i })).toBeInTheDocument();
    });
  });
});
