/**
 * Component tests — Admin → Users, after the DataTable migration (issue #67).
 *
 * ## What this file deliberately does NOT test
 *
 * Table MECHANICS are asserted exactly once, in
 * `runDataTableConformanceSuite`, against every table built on the component:
 * pagination round-trips, select-all, CSV escaping, the column picker, the axe
 * pass, keyboard navigation, the renderer switch. Re-testing them here would
 * duplicate coverage that cannot drift, and would grow by one copy per migrated
 * page.
 *
 * The suite IS invoked below, once, with THIS page's real columns — because the
 * email column's `render` puts an `<Avatar>` and a `<Typography>` inside the
 * cell that also supplies every row's accessible name, and "does the keyboard
 * model survive a two-element primary cell" is a question the built-in fixture
 * (plain text + chips + a link) does not ask.
 *
 * What remains here is PAGE-specific: the fetch/mapping layer, the mutations,
 * the roles dialog that replaced a nested menu, permission gating, and the
 * no-remount-under-poll guarantee.
 *
 * ## What this file no longer tests, and why
 *
 * Gone: `TableContainer` markup, `TablePagination` internals, and the
 * `MoreVert` chain (`getAllByRole('button', { name: '' })` picking the button
 * with an `<svg>` in it — a query that asserted the absence of an accessible
 * name). Gone too: the `window.alert` spy, replaced by an assertion on the
 * inline validation that took its place.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser, type MockUser } from '../../utils/test-utils';
import { UserList } from '../../../components/admin/UserList';
import { buildUserColumns } from '../../../components/admin/userListColumns';
import { runDataTableConformanceSuite } from '../../../components/datatable/__tests__/conformance/runDataTableConformanceSuite';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../../components/datatable/__tests__/testUtils/layoutStubs';
import { api } from '../../../services/api';
import type { UserListItem } from '../../../types';

vi.mock('../../../hooks/useUsers', () => ({
  useUsers: vi.fn(),
}));

import { useUsers } from '../../../hooks/useUsers';

const mockUseUsers = vi.mocked(useUsers);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const activeUser: UserListItem = {
  id: 'user-1',
  email: 'active@example.com',
  displayName: 'Active User',
  providerDisplayName: 'Active Provider Name',
  profileImageUrl: 'https://example.com/active.jpg',
  providerProfileImageUrl: null,
  roles: ['viewer'],
  isActive: true,
  createdAt: '2024-01-15T10:00:00Z',
  updatedAt: '2024-01-15T10:00:00Z',
};

const inactiveUser: UserListItem = {
  id: 'user-2',
  email: 'inactive@example.com',
  displayName: null,
  providerDisplayName: 'Inactive User',
  profileImageUrl: null,
  providerProfileImageUrl: 'https://example.com/inactive.jpg',
  roles: ['contributor'],
  isActive: false,
  createdAt: '2024-01-16T10:00:00Z',
  updatedAt: '2024-01-16T10:00:00Z',
};

const multiRoleUser: UserListItem = {
  id: 'admin-1',
  email: 'admin@example.com',
  displayName: 'Admin',
  providerDisplayName: 'Admin Provider',
  profileImageUrl: null,
  providerProfileImageUrl: null,
  roles: ['admin', 'contributor'],
  isActive: true,
  createdAt: '2024-01-10T10:00:00Z',
  updatedAt: '2024-01-10T10:00:00Z',
};

/** A user fixture carrying exactly the permissions named. */
function userWith(permissions: string[]): MockUser {
  return { ...mockAdminUser, permissions };
}

const mockFetchUsers = vi.fn();
const mockUpdateUser = vi.fn();
const mockUpdateUserRoles = vi.fn();

interface HookState {
  users?: UserListItem[];
  total?: number;
  isLoading?: boolean;
  error?: string | null;
}

function setHookState({
  users = [],
  total = users.length,
  isLoading = false,
  error = null,
}: HookState = {}) {
  mockUseUsers.mockReturnValue({
    users,
    total,
    page: 1,
    pageSize: 10,
    totalPages: 1,
    isLoading,
    error,
    fetchUsers: mockFetchUsers,
    updateUser: mockUpdateUser,
    updateUserRoles: mockUpdateUserRoles,
  });
}

function renderList(
  permissions: string[] = mockAdminUser.permissions,
  width = 1400,
) {
  setInitialContainerWidth(width);
  return render(<UserList />, {
    wrapperOptions: { user: userWith(permissions) },
  });
}

/** Choose an option from one of the filter editor's MUI selects. */
async function pickOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(screen.getByRole('combobox', { name: label }));
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: option }));
}

// ---------------------------------------------------------------------------

describe('UserList', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    // The table persists its layout under `user_settings.dataTables`; stub the
    // read so the suite exercises the real hook without hitting the network.
    vi.spyOn(api, 'get').mockResolvedValue({ dataTables: {} } as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
    mockUpdateUser.mockResolvedValue(undefined);
    mockUpdateUserRoles.mockResolvedValue(undefined);
    setHookState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Rendering + column mapping
  // =========================================================================

  describe('rendering', () => {
    it('renders one row per user with the mapped columns', async () => {
      setHookState({ users: [activeUser, inactiveUser], total: 2 });
      renderList();

      expect(await screen.findByText('active@example.com')).toBeInTheDocument();
      expect(screen.getByText('inactive@example.com')).toBeInTheDocument();
      // Custom display name wins; the provider name is the fallback.
      expect(screen.getByText('Active User')).toBeInTheDocument();
      expect(screen.getByText('Inactive User')).toBeInTheDocument();
      expect(screen.getByText('Active')).toBeInTheDocument();
      expect(screen.getByText('Inactive')).toBeInTheDocument();
    });

    it('renders role chips, one per role', async () => {
      setHookState({ users: [multiRoleUser], total: 1 });
      renderList();

      await screen.findByText('admin@example.com');
      expect(screen.getByText('admin')).toBeInTheDocument();
      expect(screen.getByText('contributor')).toBeInTheDocument();
    });

    it('puts the avatar INSIDE the email cell rather than in a column of its own', async () => {
      setHookState({ users: [activeUser], total: 1 });
      renderList();

      const avatar = await screen.findByRole('img', {
        name: 'active@example.com',
      });
      expect(avatar).toBeInTheDocument();

      // A thumbnail-only column would have no scalar behind it, so there must
      // be no such header. The declared headers are exactly these.
      const headers = screen
        .getAllByRole('columnheader')
        .map((header) => header.textContent?.trim())
        .filter(Boolean);
      expect(headers).toEqual(
        expect.arrayContaining(['Email', 'Status', 'Display Name', 'Roles']),
      );
      expect(headers).not.toContain('Avatar');
      expect(headers).not.toContain('User');
    });

    it('names every row control after the email, which is the row-unique primary column', async () => {
      setHookState({ users: [activeUser, inactiveUser], total: 2 });
      renderList();

      await screen.findByText('active@example.com');
      expect(
        screen.getByRole('checkbox', { name: 'Select active@example.com' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', {
          name: 'Row actions for inactive@example.com',
        }),
      ).toBeInTheDocument();
    });

    it('surfaces the hook error in an alert', async () => {
      setHookState({ error: 'Failed to load users' });
      renderList();

      expect(
        await screen.findByText('Failed to load users'),
      ).toBeInTheDocument();
    });

    it('shows a search-aware empty state', async () => {
      setHookState({ users: [], total: 0 });
      renderList();

      expect(await screen.findByText('No users found')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // `loading` is a prop, never a branch
  // =========================================================================

  describe('loading', () => {
    it('keeps the rows on screen underneath the loading overlay', async () => {
      setHookState({ users: [activeUser], total: 1, isLoading: true });
      renderList();

      // The old `{isLoading ? <CircularProgress/> : <Table/>}` ternary made
      // these two mutually exclusive. They must now coexist.
      expect(await screen.findByText('active@example.com')).toBeInTheDocument();
      expect(
        screen.getByTestId('datatable-loading-overlay'),
      ).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Fetch + query mapping
  // =========================================================================

  describe('query mapping', () => {
    it('fetches the first page on mount, converting to the API’s 1-based page', async () => {
      renderList();

      await waitFor(() => {
        expect(mockFetchUsers).toHaveBeenCalledWith(
          expect.objectContaining({ page: 1, pageSize: 10 }),
        );
      });
    });

    it('sends the quick-search term as ?search=, resetting to page 1', async () => {
      const user = userEvent.setup();
      renderList();

      await user.type(
        screen.getByRole('searchbox', { name: 'Search by email or name' }),
        'alice',
      );

      await waitFor(
        () => {
          expect(mockFetchUsers).toHaveBeenCalledWith(
            expect.objectContaining({ search: 'alice', page: 1 }),
          );
        },
        { timeout: 3000 },
      );
    });

    it('maps the Status filter onto ?isActive=', async () => {
      const user = userEvent.setup();
      setHookState({ users: [activeUser], total: 1 });
      renderList();

      await screen.findByText('active@example.com');
      // Status is the first filterable column, so it is the editor's default.
      await pickOption(user, 'Value', 'Active');
      await user.click(screen.getByTestId('datatable-filter-apply'));

      await waitFor(() => {
        expect(mockFetchUsers).toHaveBeenCalledWith(
          expect.objectContaining({ isActive: true, page: 1 }),
        );
      });
    });

    it('maps the Roles filter onto ?role=', async () => {
      const user = userEvent.setup();
      setHookState({ users: [multiRoleUser], total: 1 });
      renderList();

      await screen.findByText('admin@example.com');
      await pickOption(user, 'Column', 'Roles');
      await pickOption(user, 'Value', 'admin');
      await user.click(screen.getByTestId('datatable-filter-apply'));

      await waitFor(() => {
        expect(mockFetchUsers).toHaveBeenCalledWith(
          expect.objectContaining({ role: 'admin' }),
        );
      });
    });

    it('sends sortBy/sortOrder only for the fields the endpoint accepts', async () => {
      const user = userEvent.setup();
      setHookState({ users: [activeUser], total: 1 });
      renderList();

      await screen.findByText('active@example.com');
      await user.click(screen.getByRole('columnheader', { name: /^Email/ }));

      await waitFor(() => {
        expect(mockFetchUsers).toHaveBeenCalledWith(
          expect.objectContaining({ sortBy: 'email', sortOrder: 'asc' }),
        );
      });
    });

    it('offers no sort affordance on a column the endpoint cannot order by', async () => {
      setHookState({ users: [activeUser], total: 1 });
      renderList();

      await screen.findByText('active@example.com');
      // `sortBy` accepts email | createdAt | updatedAt only, so Display Name
      // and Roles must not advertise a sortable header.
      for (const label of ['Display Name', 'Roles']) {
        const header = screen.getByRole('columnheader', {
          name: new RegExp(`^${label}`),
        });
        expect(header).toHaveAttribute('aria-sort', 'none');
        expect(within(header).queryByRole('button')).not.toBeInTheDocument();
      }
    });
  });

  // =========================================================================
  // Mutations
  // =========================================================================

  describe('activation', () => {
    it('deactivates an active user through the row action', async () => {
      const user = userEvent.setup();
      setHookState({ users: [activeUser], total: 1 });
      renderList();

      await screen.findByText('active@example.com');
      await user.click(
        screen.getByRole('button', {
          name: 'Row actions for active@example.com',
        }),
      );
      await user.click(
        await screen.findByRole('menuitem', { name: 'Deactivate user' }),
      );

      await waitFor(() => {
        expect(mockUpdateUser).toHaveBeenCalledWith('user-1', {
          isActive: false,
        });
      });
    });

    it('activates an inactive user through the row action', async () => {
      const user = userEvent.setup();
      setHookState({ users: [inactiveUser], total: 1 });
      renderList();

      await screen.findByText('inactive@example.com');
      await user.click(
        screen.getByRole('button', {
          name: 'Row actions for inactive@example.com',
        }),
      );
      await user.click(
        await screen.findByRole('menuitem', { name: 'Activate user' }),
      );

      await waitFor(() => {
        expect(mockUpdateUser).toHaveBeenCalledWith('user-2', {
          isActive: true,
        });
      });
    });

    it('disables the inapplicable action per row rather than removing it', async () => {
      const user = userEvent.setup();
      setHookState({ users: [activeUser], total: 1 });
      renderList();

      await screen.findByText('active@example.com');
      await user.click(
        screen.getByRole('button', {
          name: 'Row actions for active@example.com',
        }),
      );

      // Both are present; "Activate" is simply not applicable to this row.
      const activate = await screen.findByRole('menuitem', {
        name: 'Activate user',
      });
      expect(activate).toHaveAttribute('aria-disabled', 'true');
      expect(
        screen.getByRole('menuitem', { name: 'Deactivate user' }),
      ).not.toHaveAttribute('aria-disabled');
    });
  });

  // =========================================================================
  // The roles dialog that replaced the nested menu
  // =========================================================================

  describe('manage roles dialog', () => {
    async function openDialog(user: ReturnType<typeof userEvent.setup>) {
      await screen.findByText('active@example.com');
      await user.click(
        screen.getByRole('button', {
          name: 'Row actions for active@example.com',
        }),
      );
      await user.click(
        await screen.findByRole('menuitem', { name: 'Manage roles' }),
      );
      return screen.findByRole('dialog');
    }

    it('opens seeded with the user’s current roles', async () => {
      const user = userEvent.setup();
      setHookState({ users: [activeUser], total: 1 });
      renderList();

      const dialog = await openDialog(user);
      expect(
        within(dialog).getByRole('checkbox', { name: 'viewer' }),
      ).toBeChecked();
      expect(
        within(dialog).getByRole('checkbox', { name: 'admin' }),
      ).not.toBeChecked();
    });

    it('saves the new role set through updateUserRoles', async () => {
      const user = userEvent.setup();
      setHookState({ users: [activeUser], total: 1 });
      renderList();

      const dialog = await openDialog(user);
      await user.click(within(dialog).getByRole('checkbox', { name: 'admin' }));
      await user.click(
        within(dialog).getByRole('button', { name: 'Save roles' }),
      );

      await waitFor(() => {
        expect(mockUpdateUserRoles).toHaveBeenCalledWith('user-1', [
          'viewer',
          'admin',
        ]);
      });
    });

    it('blocks an empty role set inline — the replacement for window.alert', async () => {
      const user = userEvent.setup();
      setHookState({ users: [activeUser], total: 1 });
      renderList();

      const dialog = await openDialog(user);
      await user.click(
        within(dialog).getByRole('checkbox', { name: 'viewer' }),
      );

      expect(
        within(dialog).getByText('User must have at least one role'),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole('button', { name: 'Save roles' }),
      ).toBeDisabled();
      expect(mockUpdateUserRoles).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Permission gating — ABSENT from the DOM, not "renders nothing"
  // =========================================================================

  describe('permission gating', () => {
    it('omits the activation actions entirely without users:write', async () => {
      const user = userEvent.setup();
      setHookState({ users: [activeUser], total: 1 });
      renderList(['users:read', 'rbac:manage']);

      await screen.findByText('active@example.com');
      // One remaining action collapses to a bare icon button, so there is no
      // "Row actions" menu at all.
      expect(
        screen.queryByRole('button', {
          name: 'Row actions for active@example.com',
        }),
      ).not.toBeInTheDocument();

      const only = screen.getByRole('button', {
        name: 'Manage roles for active@example.com',
      });
      await user.click(only);
      await screen.findByRole('dialog');

      expect(
        screen.queryByRole('menuitem', { name: 'Activate user' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('menuitem', { name: 'Deactivate user' }),
      ).not.toBeInTheDocument();
    });

    it('omits the roles action entirely without rbac:manage', async () => {
      const user = userEvent.setup();
      setHookState({ users: [activeUser], total: 1 });
      renderList(['users:read', 'users:write']);

      await screen.findByText('active@example.com');
      await user.click(
        screen.getByRole('button', {
          name: 'Row actions for active@example.com',
        }),
      );

      await screen.findByRole('menuitem', { name: 'Deactivate user' });
      expect(
        screen.queryByRole('menuitem', { name: 'Manage roles' }),
      ).not.toBeInTheDocument();
    });

    it('renders no row-action control at all on read-only permissions', async () => {
      setHookState({ users: [activeUser], total: 1 });
      renderList(['users:read']);

      await screen.findByText('active@example.com');
      expect(
        screen.queryByRole('button', { name: /active@example\.com/ }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // No remount under poll
  // =========================================================================

  describe('no remount under poll', () => {
    /**
     * The canonical regression this migration exists to prevent.
     *
     * `useUsers` replaces every row object on every fetch. The old
     * `{isLoading ? <spinner/> : <Table/>}` ternary unmounted the whole table
     * while that fetch was in flight, so a refetch discarded row expansion,
     * scroll offset and grid focus. Here the table must be the SAME DOM NODE
     * before and after, and the three pieces of user state must survive it.
     *
     * Tablet width, so `detail` columns fold into a real row expander.
     */
    it('survives a refetch that replaces every row object', async () => {
      const user = userEvent.setup();
      setHookState({ users: [activeUser, inactiveUser], total: 2 });
      const { rerender } = renderList(mockAdminUser.permissions, 800);

      await screen.findByText('active@example.com');

      // 1. Apply a filter. At tablet width the filter surface is a collapsed
      //    panel, so it has to be opened first.
      await user.click(screen.getByTestId('datatable-filter-toggle'));
      await screen.findByTestId('datatable-filter-panel');
      await pickOption(user, 'Value', 'Active');
      await user.click(screen.getByTestId('datatable-filter-apply'));
      await screen.findByLabelText(/Remove filter: Status is Active/i);

      // 2. Select a row.
      await user.click(
        screen.getByRole('checkbox', { name: 'Select active@example.com' }),
      );
      expect(
        screen.getByRole('checkbox', { name: 'Select active@example.com' }),
      ).toBeChecked();

      // 3. Expand a row.
      await user.click(
        screen.getByRole('button', {
          name: 'Show details for active@example.com',
        }),
      );
      await screen.findByRole('button', {
        name: 'Hide details for active@example.com',
      });

      const tableBefore = screen.getByTestId('admin-users-table');
      const gridBefore = screen.getByRole('grid');

      // The poll: brand-new objects, same ids, loading flag flipped both ways.
      const refetching = [{ ...activeUser }, { ...inactiveUser }];
      setHookState({ users: refetching, total: 2, isLoading: true });
      rerender(<UserList />);
      const landed = [{ ...activeUser }, { ...inactiveUser }];
      setHookState({ users: landed, total: 2, isLoading: false });
      rerender(<UserList />);

      // Same node, not merely an equivalent one.
      expect(screen.getByTestId('admin-users-table')).toBe(tableBefore);
      expect(screen.getByRole('grid')).toBe(gridBefore);

      // And all three pieces of state survived.
      expect(
        screen.getByRole('checkbox', { name: 'Select active@example.com' }),
      ).toBeChecked();
      expect(
        screen.getByRole('button', {
          name: 'Hide details for active@example.com',
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText(/Remove filter: Status is Active/i),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Shared conformance suite, run against THIS page's real columns
// ---------------------------------------------------------------------------

/**
 * Invoked here — and not on the other three migrated tables — because the
 * `email` column's `render` produces a two-element cell (`<Avatar>` +
 * `<Typography>`) that is ALSO the source of every row's accessible name. The
 * built-in fixture's primary column is plain text, so it does not ask whether
 * the keyboard model, the focus rules and the axe pass survive that shape.
 */
runDataTableConformanceSuite({
  label: 'UserList columns',
  columns: buildUserColumns(),
  rows: [activeUser, inactiveUser, multiRoleUser],
  rowId: (user: UserListItem) => user.id,
});
