import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { BottomNav } from '../../../components/navigation/BottomNav';

/**
 * The phone half of the coverage migrated from the deleted `Sidebar.test.tsx`:
 * four items, permission gating, active highlight, navigate-on-click.
 */

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { usePermissions } from '../../../hooks/usePermissions';

const mockUsePermissions = vi.mocked(usePermissions);

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

const ADMIN_PERMISSIONS = ['users:read', 'system_settings:read'];
const PHONE = 375;

/** Renders at a phone width, which is the only width this bar exists at. */
function renderPhone(route = '/') {
  const result = render(<BottomNav />, {
    wrapperOptions: { route, user: mockAdminUser },
  });
  act(() => setViewportWidth(PHONE));
  return result;
}

describe('BottomNav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions(ADMIN_PERMISSIONS, true);
    setViewportWidth(PHONE);
  });

  describe('Self-gating', () => {
    it('renders nothing at or above sm, even though Layout also unmounts it there', () => {
      // Belt and braces: `Layout` mounts it only below `sm`, and it refuses to
      // render above `sm` anyway. Either gate alone would be enough; both
      // together mean a future caller cannot mount it into the rail's band.
      render(<BottomNav />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    });

    it('renders below sm', () => {
      renderPhone();

      expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
    });

    it('appears and disappears across the sm boundary', async () => {
      renderPhone();
      expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();

      await act(async () => setViewportWidth(600));
      expect(screen.queryByRole('button', { name: 'Home' })).not.toBeInTheDocument();

      await act(async () => setViewportWidth(599));
      expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
    });
  });

  describe('Destinations', () => {
    it('renders all four destinations for a fully permitted user', () => {
      renderPhone();

      expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'User Settings' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'User Management' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'System Settings' })).toBeInTheDocument();
    });

    it('shows the compact label as visible text but the full label as the accessible name', () => {
      // A 4-up bar at 375px gives each tab ~90px; "User Management" does not fit.
      renderPhone();

      expect(screen.getByText('Users')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'User Management' })).toBeInTheDocument();
    });

    it('never renders more than four actions — showLabels depends on it', () => {
      renderPhone();

      expect(screen.getAllByRole('button')).toHaveLength(4);
    });

    it('hides destinations the user lacks permission for', () => {
      setPermissions([]);
      renderPhone();

      expect(screen.getAllByRole('button')).toHaveLength(2);
      expect(screen.queryByRole('button', { name: 'User Management' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'System Settings' })).not.toBeInTheDocument();
    });

    it('gates on permission rather than the admin role', () => {
      setPermissions(['system_settings:read'], false);
      renderPhone();

      expect(screen.getByRole('button', { name: 'System Settings' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'User Management' })).not.toBeInTheDocument();
    });
  });

  describe('Active state', () => {
    it('selects the destination that owns the route', () => {
      renderPhone('/settings');

      expect(screen.getByRole('button', { name: 'User Settings' })).toHaveClass('Mui-selected');
      expect(screen.getByRole('button', { name: 'Home' })).not.toHaveClass('Mui-selected');
    });

    it('resolves a child route to its parent destination', () => {
      renderPhone('/admin/users/abc-123');

      expect(screen.getByRole('button', { name: 'User Management' })).toHaveClass('Mui-selected');
    });

    it('selects NOTHING on a route no destination owns', () => {
      // `false`, not `null`, is what BottomNavigation wants for "nothing
      // selected" — and an unowned route is exactly where that must show.
      renderPhone('/settingsfoo');

      for (const action of screen.getAllByRole('button')) {
        expect(action).not.toHaveClass('Mui-selected');
      }
    });

    it('selects nothing when the active destination is one the user cannot see', () => {
      setPermissions([]);
      renderPhone('/admin/settings');

      for (const action of screen.getAllByRole('button')) {
        expect(action).not.toHaveClass('Mui-selected');
      }
    });
  });

  describe('Navigation', () => {
    it('navigates to the destination path on tap', async () => {
      const user = userEvent.setup();
      renderPhone('/');

      await user.click(screen.getByRole('button', { name: 'User Settings' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'User Settings' })).toHaveClass('Mui-selected');
      });
    });

    it('reaches every destination the old Sidebar offered', async () => {
      const user = userEvent.setup();
      renderPhone('/');

      for (const name of ['User Settings', 'User Management', 'System Settings', 'Home']) {
        await user.click(screen.getByRole('button', { name }));
        await waitFor(() => {
          expect(screen.getByRole('button', { name })).toHaveClass('Mui-selected');
        });
      }
    });
  });
});
