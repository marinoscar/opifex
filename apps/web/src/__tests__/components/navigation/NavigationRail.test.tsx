import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { NavigationRail } from '../../../components/navigation/NavigationRail';
import { DESTINATIONS, SECTIONS } from '../../../config/destinations';

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

const ADMIN_PERMISSIONS = [
  'users:read',
  'system_settings:read',
  'workorders:read',
  'runs:read',
  'projects:read',
  // #98 gave the Approvals destination a real permission, and `prisma/seed.ts`
  // grants `approvals:read` to all three roles.
  'approvals:read',
];

/**
 * What a real seeded VIEWER holds.
 *
 * The default here used to be `[]`, which stopped representing anybody once
 * #80 gave the Queue destination a real permission: `prisma/seed.ts` grants
 * `workorders:read` to all three roles, so a permission-less user is not a
 * viewer, it is a user the API cannot produce. Testing navigation against one
 * would assert that a Viewer cannot see the Queue, which is false.
 */
const VIEWER_PERMISSIONS = [
  'workorders:read',
  'runs:read',
  'projects:read',
  // A seeded viewer really does hold this: they may see what is waiting and
  // answer nothing (`approvals:decide` is withheld). A fixture without it
  // would assert that a viewer cannot reach the approval queue, which is false.
  'approvals:read',
];

describe('NavigationRail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions(VIEWER_PERMISSIONS);
    setPrefs(false);
  });

  describe('Destinations', () => {
    it('renders one link per destination the user can see', () => {
      // Counted against the TABLE, not against a literal. The old version of
      // this assertion was `toHaveLength(4)`, which turned adding a destination
      // into a test failure rather than into a covered change.
      setPermissions(ADMIN_PERMISSIONS, true);

      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      const nav = screen.getByRole('navigation', { name: /main navigation/i });
      expect(within(nav).getAllByRole('link')).toHaveLength(
        DESTINATIONS.length,
      );
      for (const destination of DESTINATIONS) {
        expect(
          screen.getByRole('link', { name: destination.label }),
        ).toBeInTheDocument();
      }
    });

    it('offers every cockpit destination to a plain VIEWER', () => {
      // #80 gave all four a real permission, which is only safe because
      // `prisma/seed.ts` grants the read side of each to viewer, contributor
      // and admin alike. If it did not, the app's shape would be visible only
      // to admins — which is what this test has always been guarding, first
      // when the destinations were unpermissioned and now that they are not.
      render(<NavigationRail />);

      expect(screen.getByRole('link', { name: 'Runs' })).toHaveAttribute(
        'href',
        '/runs',
      );
      expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute(
        'href',
        '/projects',
      );
      expect(screen.getByRole('link', { name: 'Cost' })).toHaveAttribute(
        'href',
        '/cost',
      );
    });

    it('hides Projects from a user without projects:read', () => {
      // The permission is real and enforced by RepositoriesController, so the
      // navigation must reflect it rather than offering a link that 403s.
      setPermissions([]);

      render(<NavigationRail />);

      expect(
        screen.queryByRole('link', { name: 'Projects' }),
      ).not.toBeInTheDocument();
    });

    it('offers the Queue to a viewer, who really does hold workorders:read', () => {
      // #80 moved Queue from planned to live and gave it a permission. That is
      // only safe because `prisma/seed.ts` grants `workorders:read` to viewer,
      // contributor and admin alike — if it did not, this destination would
      // have vanished for most of the people the cockpit is for.
      render(<NavigationRail />);

      expect(screen.getByRole('link', { name: 'Queue' })).toHaveAttribute(
        'href',
        '/queue',
      );
    });

    it('hides the Queue from a user without workorders:read', () => {
      // The permission is real and it is enforced, so the navigation must
      // reflect it rather than offering a link that 403s.
      setPermissions([]);

      render(<NavigationRail />);

      expect(
        screen.queryByRole('link', { name: 'Queue' }),
      ).not.toBeInTheDocument();
    });

    it('hides the admin destinations from a user without the permissions', () => {
      render(<NavigationRail />);

      expect(screen.getByRole('link', { name: 'Cockpit' })).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: 'User Settings' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: 'User Management' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: 'System Settings' }),
      ).not.toBeInTheDocument();
    });

    it('gates on PERMISSION, not on the admin role', () => {
      // The bug this replaces: the old Sidebar gated on the `admin` role while
      // UserMenu gated on `system_settings:read`, so a Contributor granted that
      // permission got a menu entry and a working page with no route in.
      setPermissions(['system_settings:read'], false);

      render(<NavigationRail />);

      expect(
        screen.getByRole('link', { name: 'System Settings' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: 'User Management' }),
      ).not.toBeInTheDocument();
    });

    it('shows User Management on users:read alone', () => {
      setPermissions(['users:read'], false);

      render(<NavigationRail />);

      expect(
        screen.getByRole('link', { name: 'User Management' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: 'System Settings' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('Links, not click handlers', () => {
    it('renders each row as a real anchor with an href', () => {
      // An onClick div gives up focus, middle-click and tab order — and needed
      // the `setTimeout(() => navigate(path), 0)` the drawer forced on it.
      setPermissions(ADMIN_PERMISSIONS, true);

      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('link', { name: 'Cockpit' })).toHaveAttribute(
        'href',
        '/',
      );
      expect(
        screen.getByRole('link', { name: 'User Settings' }),
      ).toHaveAttribute('href', '/settings');
      expect(
        screen.getByRole('link', { name: 'User Management' }),
      ).toHaveAttribute('href', '/admin/users');
      expect(
        screen.getByRole('link', { name: 'System Settings' }),
      ).toHaveAttribute('href', '/admin/settings');
    });

    it('navigates on click without any deferred timer', async () => {
      const user = userEvent.setup();
      render(<NavigationRail />, { wrapperOptions: { route: '/' } });

      await user.click(screen.getByRole('link', { name: 'User Settings' }));

      await waitFor(() => {
        expect(
          screen.getByRole('link', { name: 'User Settings' }),
        ).toHaveAttribute('aria-current', 'page');
      });
    });
  });

  describe('Active state', () => {
    it('marks the active destination with aria-current="page"', () => {
      render(<NavigationRail />, { wrapperOptions: { route: '/settings' } });

      expect(
        screen.getByRole('link', { name: 'User Settings' }),
      ).toHaveAttribute('aria-current', 'page');
      expect(screen.getByRole('link', { name: 'Cockpit' })).not.toHaveAttribute(
        'aria-current',
      );
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
      expect(
        screen.getByRole('link', { name: 'User Settings' }),
      ).toBeInTheDocument();
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

      const toggle = screen.getByRole('button', {
        name: /collapse navigation/i,
      });
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

      await user.click(
        screen.getByRole('button', { name: /collapse navigation/i }),
      );

      expect(toggleRailCollapsed).toHaveBeenCalledTimes(1);
    });

    it('is desktop-only — the medium tier is forced collapsed, so a toggle there would lie', async () => {
      render(<NavigationRail />);

      await act(async () => setViewportWidth(800));

      expect(
        screen.queryByRole('button', { name: /navigation/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('is a nav landmark with an accessible name', () => {
      render(<NavigationRail />);

      expect(
        screen.getByRole('navigation', { name: 'Main navigation' }),
      ).toBeInTheDocument();
    });

    it('keeps DOM order equal to visual order, so focus order follows it', () => {
      setPermissions(ADMIN_PERMISSIONS, true);

      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      // Sections do not reorder the table: the rail's DOM order is the
      // destination order, grouped. Anything else and the tab order stops
      // matching what the eye is reading down the column.
      expect(
        screen.getAllByRole('link').map((link) => link.getAttribute('href')),
      ).toEqual([
        '/',
        '/runs',
        '/approvals',
        '/queue',
        '/projects',
        '/cost',
        '/settings',
        '/admin/users',
        '/admin/settings',
      ]);
    });
  });
  /**
   * Issue #71. Eight destinations in one undifferentiated column is a list to
   * be read rather than a map to be scanned, so the rail groups them. The
   * grouping is announced identically in both treatments (each group is its own
   * named `<ul>`) but DRAWN differently: a header when there is room for one,
   * a divider when there is not.
   */
  describe('Sections', () => {
    it('names every populated group for assistive technology, in both treatments', async () => {
      setPermissions(ADMIN_PERMISSIONS, true);

      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      for (const section of SECTIONS) {
        expect(
          screen.getByRole('list', { name: section.label }),
        ).toBeInTheDocument();
      }

      // Collapsed, the visible header is gone but the accessible name is not —
      // that is the whole reason the name lives on the list rather than only in
      // the header text.
      await act(async () => setViewportWidth(800));

      for (const section of SECTIONS) {
        expect(
          screen.getByRole('list', { name: section.label }),
        ).toBeInTheDocument();
      }
    });

    it('shows a visible section header when expanded', () => {
      setPermissions(ADMIN_PERMISSIONS, true);

      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      for (const section of SECTIONS) {
        expect(screen.getByText(section.label)).toBeInTheDocument();
      }
    });

    it('replaces the headers with dividers when collapsed', async () => {
      // 56px does not hold "Administration" at a legible size, and an
      // abbreviation would be a second vocabulary for the same thing.
      setPermissions(ADMIN_PERMISSIONS, true);

      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      await act(async () => setViewportWidth(800));

      for (const section of SECTIONS) {
        expect(screen.queryByText(section.label)).not.toBeInTheDocument();
      }
      // One separator BETWEEN each pair of groups, never a leading or trailing
      // one. The medium tier has no collapse toggle, so these are the only
      // dividers in the rail.
      const nav = screen.getByRole('navigation', { name: 'Main navigation' });
      expect(within(nav).getAllByRole('separator')).toHaveLength(
        SECTIONS.length - 1,
      );
    });

    it('drops a section that empties under permission filtering', async () => {
      // A Viewer has no Administration destinations. A header with nothing
      // under it — or a divider fencing off empty space — reads as a failure to
      // load rather than as an absence.
      setPermissions([]);

      render(<NavigationRail />);

      expect(screen.queryByText('Administration')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('list', { name: 'Administration' }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('list', { name: 'Operate' })).toBeInTheDocument();
      expect(screen.getByRole('list', { name: 'Account' })).toBeInTheDocument();

      await act(async () => setViewportWidth(800));

      const nav = screen.getByRole('navigation', { name: 'Main navigation' });
      // Two groups left, so exactly one divider — not two with a gap where
      // Administration used to be.
      expect(within(nav).getAllByRole('separator')).toHaveLength(1);
    });

    it('keeps every destination inside its declared section', () => {
      setPermissions(ADMIN_PERMISSIONS, true);

      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      for (const section of SECTIONS) {
        const list = screen.getByRole('list', { name: section.label });
        const expected = DESTINATIONS.filter(
          (d) => d.section === section.key,
        ).map((d) => d.path);
        expect(
          within(list)
            .getAllByRole('link')
            .map((link) => link.getAttribute('href')),
        ).toEqual(expected);
      }
    });
  });
});
