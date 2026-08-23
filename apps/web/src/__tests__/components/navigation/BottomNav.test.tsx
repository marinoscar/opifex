import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { BottomNav } from '../../../components/navigation/BottomNav';
import {
  BOTTOM_NAV_MAX_ACTIONS,
  DESTINATIONS,
  bottomNavSplit,
} from '../../../config/destinations';

/**
 * The phone half of the navigation. Issue #72, epic #19.
 *
 * The bar now carries three real destinations plus a synthetic More action
 * that opens an overflow sheet, and the assertion this suite exists for is the
 * ceiling: FOUR ACTIONS, at every permission shape, because `showLabels` is
 * only legible at 360px while that holds. Nothing on screen tells you when it
 * breaks — the labels just start truncating on the narrowest phones, which is
 * the device least likely to be in the reviewer's hands.
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

const ADMIN_PERMISSIONS = [
  'users:read',
  'system_settings:read',
  'workorders:read',
  'runs:read',
  'projects:read',
];

/**
 * What a real seeded VIEWER holds.
 *
 * `[]` stopped representing anybody once #80 gave the Queue destination a real
 * permission: `prisma/seed.ts` grants `workorders:read` to all three roles, so
 * a permission-less user is not a viewer, it is a user the API cannot produce.
 */
const VIEWER_PERMISSIONS = ['workorders:read', 'runs:read', 'projects:read'];
const PHONE = 375;

/** Renders at a phone width, which is the only width this bar exists at. */
function renderPhone(route = '/') {
  const result = render(<BottomNav />, {
    wrapperOptions: { route, user: mockAdminUser },
  });
  act(() => setViewportWidth(PHONE));
  return result;
}

/** The bar's own actions — not the links inside an opened sheet. */
function barActions() {
  return screen.getAllByRole('button');
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

      expect(barActions().length).toBeGreaterThan(0);
    });

    it('appears and disappears across the sm boundary', async () => {
      renderPhone();
      expect(screen.getByRole('button', { name: 'Cockpit' })).toBeInTheDocument();

      await act(async () => setViewportWidth(600));
      expect(screen.queryByRole('button', { name: 'Cockpit' })).not.toBeInTheDocument();

      await act(async () => setViewportWidth(599));
      expect(screen.getByRole('button', { name: 'Cockpit' })).toBeInTheDocument();
    });
  });

  describe('The four-action ceiling', () => {
    it('never renders more than four actions, at any permission shape', () => {
      // The load-bearing assertion of the whole component. Every shape a real
      // user can have, including the ones that add and remove destinations.
      const shapes = [
        [],
        ['users:read'],
        ['system_settings:read'],
        ADMIN_PERMISSIONS,
      ];

      for (const granted of shapes) {
        setPermissions(granted, granted.length > 0);
        const { unmount } = renderPhone();

        expect(barActions().length, `permissions: [${granted.join(', ')}]`).toBeLessThanOrEqual(
          BOTTOM_NAV_MAX_ACTIONS,
        );

        unmount();
      }
    });

    it('renders the three primaries plus More for a fully permitted user', () => {
      renderPhone();

      expect(barActions()).toHaveLength(4);
      expect(screen.getByRole('button', { name: 'Cockpit' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Runs' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Queue' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'More destinations' })).toBeInTheDocument();
    });

    it('keeps the same three tabs for a user with no admin permissions', () => {
      // The bar's SHAPE is stable across roles — only the sheet's contents
      // change. A bar that reflows between roles is a bar whose muscle memory
      // is worthless. A viewer holds `workorders:read` (see VIEWER_PERMISSIONS),
      // so Queue stays on the bar for them too.
      setPermissions(VIEWER_PERMISSIONS);
      renderPhone();

      expect(barActions()).toHaveLength(4);
      expect(screen.getByRole('button', { name: 'Runs' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Queue' })).toBeInTheDocument();
    });

    it('closes the bar up when a user lacks a primary permission', () => {
      // The one case that DOES reflow, and it must not leave a hole: a user
      // without `workorders:read` loses Queue and the bar renders three
      // actions rather than four with a gap. Granting `runs:read` and NOT
      // `workorders:read` drops exactly one primary — `[]` would drop both
      // once #80 gave Runs a permission too, and stop testing the one-gap
      // case this is named for.
      setPermissions(['runs:read']);
      renderPhone();

      expect(screen.queryByRole('button', { name: 'Queue' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cockpit' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Runs' })).toBeInTheDocument();
    });

    it('shows the compact label as visible text but the full label as the accessible name', () => {
      // A 4-up bar at 375px gives each tab ~90px; "User Management" does not fit
      // — which is exactly why that destination lives in the sheet now.
      renderPhone();

      expect(screen.getByText('Cockpit')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'More destinations' })).toHaveTextContent('More');
    });
  });

  describe('Active state', () => {
    it('selects the primary that owns the route', () => {
      renderPhone('/queue');

      expect(screen.getByRole('button', { name: 'Queue' })).toHaveClass('Mui-selected');
      expect(screen.getByRole('button', { name: 'Cockpit' })).not.toHaveClass('Mui-selected');
    });

    it('selects More when the route belongs to an overflow destination', () => {
      // The operator IS somewhere. "Nothing selected" while standing on
      // /settings would be a lie about location, not a tasteful absence.
      renderPhone('/settings');

      expect(screen.getByRole('button', { name: 'More destinations' })).toHaveClass(
        'Mui-selected',
      );
    });

    it('resolves a child route to its parent destination', () => {
      renderPhone('/admin/users/abc-123');

      expect(screen.getByRole('button', { name: 'More destinations' })).toHaveClass(
        'Mui-selected',
      );
    });

    it('selects NOTHING on a route no destination owns', () => {
      // `false`, not `null`, is what BottomNavigation wants for "nothing
      // selected" — and an unowned route is exactly where that must show.
      renderPhone('/settingsfoo');

      for (const action of barActions()) {
        expect(action).not.toHaveClass('Mui-selected');
      }
    });

    it('selects nothing when the active destination is one the user cannot see', () => {
      setPermissions([]);
      renderPhone('/admin/settings');

      for (const action of barActions()) {
        expect(action).not.toHaveClass('Mui-selected');
      }
    });
  });

  describe('Navigation', () => {
    it('navigates to the destination path on tap', async () => {
      const user = userEvent.setup();
      renderPhone('/');

      await user.click(screen.getByRole('button', { name: 'Runs' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Runs' })).toHaveClass('Mui-selected');
      });
    });

    it('reaches every primary destination', async () => {
      const user = userEvent.setup();
      renderPhone('/');

      for (const name of ['Runs', 'Queue', 'Cockpit']) {
        await user.click(screen.getByRole('button', { name }));
        await waitFor(() => {
          expect(screen.getByRole('button', { name })).toHaveClass('Mui-selected');
        });
      }
    });
  });

  describe('The More sheet', () => {
    it('opens a labelled dialog holding exactly the overflow set', async () => {
      const user = userEvent.setup();
      renderPhone('/');

      await user.click(screen.getByRole('button', { name: 'More destinations' }));

      const sheet = await screen.findByRole('dialog', { name: 'More destinations' });
      const { overflow } = bottomNavSplit(() => true);

      for (const destination of overflow) {
        expect(
          within(sheet).getByRole('link', { name: destination.label }),
        ).toHaveAttribute('href', destination.path);
      }
      // EXACTLY the overflow: no destination appears both on the bar and in the
      // sheet, and none is invented locally.
      expect(within(sheet).getAllByRole('link')).toHaveLength(overflow.length);
      expect(
        within(sheet).queryByRole('link', { name: 'Cockpit' }),
      ).not.toBeInTheDocument();
    });

    it('every destination is reachable from the bar or the sheet', async () => {
      // The claim the overflow design has to make good on: adding four
      // destinations must not strand any of them on a phone.
      const user = userEvent.setup();
      renderPhone('/');

      // Collected BEFORE the sheet opens: the modal marks the rest of the
      // document `aria-hidden`, so a role query would not find the bar's own
      // tabs while it is up — correctly, since they are not reachable then.
      const onBar = barActions().map((action) => action.getAttribute('aria-label'));

      await user.click(screen.getByRole('button', { name: 'More destinations' }));
      const sheet = await screen.findByRole('dialog', { name: 'More destinations' });

      for (const destination of DESTINATIONS) {
        const inSheet = within(sheet).queryByRole('link', { name: destination.label });
        expect(
          onBar.includes(destination.label) || inSheet !== null,
          `${destination.key} is unreachable`,
        ).toBe(true);
      }
    });

    it('hides the destinations the user lacks permission for', async () => {
      const user = userEvent.setup();
      setPermissions(VIEWER_PERMISSIONS);
      renderPhone('/');

      await user.click(screen.getByRole('button', { name: 'More destinations' }));
      const sheet = await screen.findByRole('dialog', { name: 'More destinations' });

      expect(within(sheet).getByRole('link', { name: 'User Settings' })).toBeInTheDocument();
      expect(
        within(sheet).queryByRole('link', { name: 'User Management' }),
      ).not.toBeInTheDocument();
      expect(
        within(sheet).queryByRole('link', { name: 'System Settings' }),
      ).not.toBeInTheDocument();
    });

    it('gates on permission rather than the admin role', async () => {
      const user = userEvent.setup();
      setPermissions(['system_settings:read'], false);
      renderPhone('/');

      await user.click(screen.getByRole('button', { name: 'More destinations' }));
      const sheet = await screen.findByRole('dialog', { name: 'More destinations' });

      expect(within(sheet).getByRole('link', { name: 'System Settings' })).toBeInTheDocument();
      expect(
        within(sheet).queryByRole('link', { name: 'User Management' }),
      ).not.toBeInTheDocument();
    });

    it('groups the sheet by section', async () => {
      const user = userEvent.setup();
      renderPhone('/');

      await user.click(screen.getByRole('button', { name: 'More destinations' }));
      const sheet = await screen.findByRole('dialog', { name: 'More destinations' });

      expect(within(sheet).getByRole('list', { name: 'Operate' })).toBeInTheDocument();
      expect(within(sheet).getByRole('list', { name: 'Account' })).toBeInTheDocument();
      expect(within(sheet).getByRole('list', { name: 'Administration' })).toBeInTheDocument();
    });

    it('drops a section that empties under permission filtering', async () => {
      // No orphan "Administration" header above nothing for a Viewer.
      const user = userEvent.setup();
      setPermissions([]);
      renderPhone('/');

      await user.click(screen.getByRole('button', { name: 'More destinations' }));
      const sheet = await screen.findByRole('dialog', { name: 'More destinations' });

      expect(within(sheet).queryByRole('list', { name: 'Administration' })).not.toBeInTheDocument();
      expect(within(sheet).queryByText('Administration')).not.toBeInTheDocument();
    });

    it('closes when a destination is chosen', async () => {
      // Otherwise the sheet sits over the page it just navigated to, which on a
      // phone reads as "the tap did nothing".
      const user = userEvent.setup();
      renderPhone('/');

      await user.click(screen.getByRole('button', { name: 'More destinations' }));
      const sheet = await screen.findByRole('dialog', { name: 'More destinations' });
      await user.click(within(sheet).getByRole('link', { name: 'User Settings' }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: 'More destinations' })).toHaveClass(
        'Mui-selected',
      );
    });

    it('closes on Escape without navigating', async () => {
      const user = userEvent.setup();
      renderPhone('/');

      await user.click(screen.getByRole('button', { name: 'More destinations' }));
      await screen.findByRole('dialog', { name: 'More destinations' });

      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      // Still on `/`, so the Cockpit tab is still the selected one.
      expect(screen.getByRole('button', { name: 'Cockpit' })).toHaveClass('Mui-selected');
    });

    it('reports its expanded state on the trigger', async () => {
      const user = userEvent.setup();
      renderPhone('/');

      const more = screen.getByRole('button', { name: 'More destinations' });
      expect(more).toHaveAttribute('aria-expanded', 'false');
      expect(more).toHaveAttribute('aria-haspopup', 'dialog');

      await user.click(more);

      // Held by reference rather than re-queried: with the sheet open the bar
      // is behind the modal's `aria-hidden`, so a role query would (rightly)
      // not see it.
      await waitFor(() => {
        expect(more).toHaveAttribute('aria-expanded', 'true');
      });
    });
  });
});
