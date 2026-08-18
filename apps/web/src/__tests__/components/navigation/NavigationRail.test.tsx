import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { NavigationRail } from '../../../components/navigation/NavigationRail';

/**
 * Coverage migrated from the deleted `Sidebar.test.tsx` — four items, admin
 * gating, active highlight, navigate-on-click — plus what the rail adds that a
 * temporary drawer never had: two width treatments, a persisted collapse
 * preference, and real links.
 */

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../../hooks/useNavigationPrefs', () => ({
  useNavigationPrefs: vi.fn(),
}));

import { usePermissions } from '../../../hooks/usePermissions';
import { useNavigationPrefs } from '../../../hooks/useNavigationPrefs';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseNavigationPrefs = vi.mocked(useNavigationPrefs);

const toggleRailCollapsed = vi.fn();

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

function setPrefs(railCollapsed: boolean) {
  mockUseNavigationPrefs.mockReturnValue({
    railCollapsed,
    toggleRailCollapsed,
    isLoading: false,
  });
}

const ADMIN_PERMISSIONS = ['users:read', 'system_settings:read'];

describe('NavigationRail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions([]);
    setPrefs(false);
  });

  describe('Destinations', () => {
    it('renders all four destinations for a fully permitted user', () => {
      setPermissions(ADMIN_PERMISSIONS, true);

      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      const nav = screen.getByRole('navigation', { name: /main navigation/i });
      expect(within(nav).getAllByRole('link')).toHaveLength(4);
      expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'User Settings' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'User Management' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'System Settings' })).toBeInTheDocument();
    });

    it('hides the admin destinations from a user without the permissions', () => {
      render(<NavigationRail />);

      expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'User Settings' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'User Management' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'System Settings' })).not.toBeInTheDocument();
    });

    it('gates on PERMISSION, not on the admin role', () => {
      // The bug this replaces: the old Sidebar gated on the `admin` role while
      // UserMenu gated on `system_settings:read`, so a Contributor granted that
      // permission got a menu entry and a working page with no route in.
      setPermissions(['system_settings:read'], false);

      render(<NavigationRail />);

      expect(screen.getByRole('link', { name: 'System Settings' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'User Management' })).not.toBeInTheDocument();
    });

    it('shows User Management on users:read alone', () => {
      setPermissions(['users:read'], false);

      render(<NavigationRail />);

      expect(screen.getByRole('link', { name: 'User Management' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'System Settings' })).not.toBeInTheDocument();
    });
  });

  describe('Links, not click handlers', () => {
    it('renders each row as a real anchor with an href', () => {
      // An onClick div gives up focus, middle-click and tab order — and needed
      // the `setTimeout(() => navigate(path), 0)` the drawer forced on it.
      setPermissions(ADMIN_PERMISSIONS, true);

      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
      expect(screen.getByRole('link', { name: 'User Settings' })).toHaveAttribute(
        'href',
        '/settings',
      );
      expect(screen.getByRole('link', { name: 'User Management' })).toHaveAttribute(
        'href',
        '/admin/users',
      );
      expect(screen.getByRole('link', { name: 'System Settings' })).toHaveAttribute(
        'href',
        '/admin/settings',
      );
    });

    it('navigates on click without any deferred timer', async () => {
      const user = userEvent.setup();
      render(<NavigationRail />, { wrapperOptions: { route: '/' } });

      await user.click(screen.getByRole('link', { name: 'User Settings' }));

      await waitFor(() => {
        expect(screen.getByRole('link', { name: 'User Settings' })).toHaveAttribute(
          'aria-current',
          'page',
        );
      });
    });
  });

  describe('Active state', () => {
    it('marks the active destination with aria-current="page"', () => {
      render(<NavigationRail />, { wrapperOptions: { route: '/settings' } });

      expect(screen.getByRole('link', { name: 'User Settings' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
    });

    it('marks exactly one row active on a nested admin route', () => {
      setPermissions(ADMIN_PERMISSIONS, true);

      render(<NavigationRail />, {
        wrapperOptions: { route: '/admin/settings', user: mockAdminUser },
      });

      const current = screen
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page');
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveAccessibleName('System Settings');
    });

    it('marks nothing active on a route no destination owns', () => {
      // `/settingsfoo` would match under the old `startsWith` isActive.
      render(<NavigationRail />, { wrapperOptions: { route: '/settingsfoo' } });

      const current = screen
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page');
      expect(current).toHaveLength(0);
    });
  });

  describe('Two treatments', () => {
    it('shows full labels as visible text at >= lg', () => {
      render(<NavigationRail />);

      expect(screen.getByText('User Settings')).toBeInTheDocument();
      expect(screen.queryByText('Settings')).not.toBeInTheDocument();
    });

    it('shows compact captions below lg, with the full label still accessible', async () => {
      render(<NavigationRail />);

      await act(async () => setViewportWidth(800));

      // The caption is aria-hidden; the accessible name is still the full label,
      // so the row is findable by it either way.
      expect(screen.getByText('Settings')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'User Settings' })).toBeInTheDocument();
    });

    it('stays collapsed below lg even when the stored preference says expanded', async () => {
      // Honouring `railCollapsed: false` at 800px would render a 220px rail on
      // a screen that has room for 56.
      setPrefs(false);
      render(<NavigationRail />);

      await act(async () => setViewportWidth(800));

      expect(screen.getByText('Settings')).toBeInTheDocument();
      expect(screen.queryByText('User Settings')).not.toBeInTheDocument();
    });

    it('honours the stored collapse preference at >= lg', () => {
      setPrefs(true);

      render(<NavigationRail />);

      expect(screen.getByText('Settings')).toBeInTheDocument();
      expect(screen.queryByText('User Settings')).not.toBeInTheDocument();
    });
  });

  describe('Collapse toggle', () => {
    it('is a real button carrying aria-expanded', () => {
      render(<NavigationRail />);

      const toggle = screen.getByRole('button', { name: /collapse navigation/i });
      expect(toggle.tagName).toBe('BUTTON');
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
    });

    it('reports aria-expanded=false when the rail is collapsed', () => {
      setPrefs(true);

      render(<NavigationRail />);

      const toggle = screen.getByRole('button', { name: /expand navigation/i });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });

    it('calls the persisted toggle on click', async () => {
      const user = userEvent.setup();
      render(<NavigationRail />);

      await user.click(screen.getByRole('button', { name: /collapse navigation/i }));

      expect(toggleRailCollapsed).toHaveBeenCalledTimes(1);
    });

    it('is desktop-only — the medium tier is forced collapsed, so a toggle there would lie', async () => {
      render(<NavigationRail />);

      await act(async () => setViewportWidth(800));

      expect(screen.queryByRole('button', { name: /navigation/i })).not.toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('is a nav landmark with an accessible name', () => {
      render(<NavigationRail />);

      expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    });

    it('keeps DOM order equal to visual order, so focus order follows it', () => {
      setPermissions(ADMIN_PERMISSIONS, true);

      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
        '/',
        '/settings',
        '/admin/users',
        '/admin/settings',
      ]);
    });
  });
});
