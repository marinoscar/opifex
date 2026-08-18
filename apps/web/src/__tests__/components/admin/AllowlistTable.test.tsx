/**
 * Component tests — Admin → Allowlist, after the DataTable migration (#67).
 *
 * Table mechanics (pagination round-trips, select-all, CSV escaping, the column
 * picker, the axe pass, keyboard navigation) are asserted once by
 * `runDataTableConformanceSuite` and are NOT repeated here. The suite is not
 * invoked with these columns either: nothing in them renders anything the
 * built-in fixture does not already exercise — a chip, plain text and a
 * truncated cell are all in the fixture.
 *
 * Gone from the old file: `TableContainer` markup, `TablePagination` internals,
 * and — the substantive one — the `window.confirm` spy. The native dialog is
 * replaced by the row action's own `confirm` option, so the confirmation is now
 * asserted as a real dialog with real buttons rather than as a stubbed global.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser, type MockUser } from '../../utils/test-utils';
import { AllowlistTable } from '../../../components/admin/AllowlistTable';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../../components/datatable/__tests__/testUtils/layoutStubs';
import { api } from '../../../services/api';
import type { AllowedEmailEntry } from '../../../types';

vi.mock('../../../hooks/useAllowlist', () => ({
  useAllowlist: vi.fn(),
}));

import { useAllowlist } from '../../../hooks/useAllowlist';

const mockUseAllowlist = vi.mocked(useAllowlist);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pendingEntry: AllowedEmailEntry = {
  id: 'entry-1',
  email: 'pending@example.com',
  notes: 'Test note',
  addedAt: '2024-01-15T10:00:00Z',
  claimedAt: null,
  addedBy: { id: 'admin-id', email: 'admin@example.com' },
  claimedBy: null,
};

const claimedEntry: AllowedEmailEntry = {
  id: 'entry-2',
  email: 'claimed@example.com',
  notes: null,
  addedAt: '2024-01-15T10:00:00Z',
  claimedAt: '2024-01-16T10:00:00Z',
  addedBy: { id: 'admin-id', email: 'admin@example.com' },
  claimedBy: { id: 'user-id', email: 'user@example.com' },
};

/** A seeded entry: no `addedBy`, which the column renders as "System". */
const systemEntry: AllowedEmailEntry = {
  id: 'entry-3',
  email: 'seeded@example.com',
  notes: null,
  addedAt: '2024-01-14T10:00:00Z',
  claimedAt: null,
  addedBy: null,
  claimedBy: null,
};

const mockFetchAllowlist = vi.fn();
const mockAddEmail = vi.fn();
const mockRemoveEmail = vi.fn();

function userWith(permissions: string[]): MockUser {
  return { ...mockAdminUser, permissions };
}

function setHookState({
  entries = [] as AllowedEmailEntry[],
  total = entries.length,
  isLoading = false,
  error = null as string | null,
} = {}) {
  mockUseAllowlist.mockReturnValue({
    entries,
    total,
    page: 1,
    pageSize: 10,
    totalPages: 1,
    isLoading,
    error,
    fetchAllowlist: mockFetchAllowlist,
    addEmail: mockAddEmail,
    removeEmail: mockRemoveEmail,
  });
}

function renderTable(permissions: string[] = mockAdminUser.permissions, width = 1400) {
  setInitialContainerWidth(width);
  return render(<AllowlistTable />, { wrapperOptions: { user: userWith(permissions) } });
}

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

describe('AllowlistTable', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    vi.spyOn(api, 'get').mockResolvedValue({ dataTables: {} } as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
    mockAddEmail.mockResolvedValue(undefined);
    mockRemoveEmail.mockResolvedValue(undefined);
    setHookState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Rendering + column mapping
  // =========================================================================

  describe('rendering', () => {
    it('renders one row per entry with the mapped columns', async () => {
      setHookState({ entries: [pendingEntry, claimedEntry], total: 2 });
      renderTable();

      expect(await screen.findByText('pending@example.com')).toBeInTheDocument();
      expect(screen.getByText('claimed@example.com')).toBeInTheDocument();
      expect(screen.getByText('Pending')).toBeInTheDocument();
      expect(screen.getByText('Claimed')).toBeInTheDocument();
      expect(screen.getAllByText('admin@example.com').length).toBeGreaterThan(0);
      expect(screen.getByText('Test note')).toBeInTheDocument();
    });

    it('renders "System" for a seeded entry with no adder, and a dash for absent notes', async () => {
      setHookState({ entries: [systemEntry], total: 1 });
      renderTable();

      await screen.findByText('seeded@example.com');
      expect(screen.getByText('System')).toBeInTheDocument();
      expect(screen.getByText('-')).toBeInTheDocument();
    });

    it('names every row control after the email', async () => {
      setHookState({ entries: [pendingEntry], total: 1 });
      renderTable();

      await screen.findByText('pending@example.com');
      expect(
        screen.getByRole('button', { name: 'Remove for pending@example.com' }),
      ).toBeInTheDocument();
    });

    it('surfaces the hook error in an alert', async () => {
      setHookState({ error: 'Failed to load allowlist' });
      renderTable();

      expect(await screen.findByText('Failed to load allowlist')).toBeInTheDocument();
    });

    it('shows the empty state', async () => {
      renderTable();
      expect(await screen.findByText('No emails in allowlist')).toBeInTheDocument();
    });

    it('keeps rows on screen underneath the loading overlay', async () => {
      setHookState({ entries: [pendingEntry], total: 1, isLoading: true });
      renderTable();

      expect(await screen.findByText('pending@example.com')).toBeInTheDocument();
      expect(screen.getByTestId('datatable-loading-overlay')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Fetch + query mapping
  // =========================================================================

  describe('query mapping', () => {
    it('fetches the first page on mount', async () => {
      renderTable();

      await waitFor(() => {
        expect(mockFetchAllowlist).toHaveBeenCalledWith(
          expect.objectContaining({ page: 1, pageSize: 10, status: 'all' }),
        );
      });
    });

    it('sends the quick-search term as ?search=', async () => {
      const user = userEvent.setup();
      renderTable();

      await user.type(screen.getByRole('searchbox', { name: 'Search by email' }), 'ada');

      await waitFor(
        () => {
          expect(mockFetchAllowlist).toHaveBeenCalledWith(
            expect.objectContaining({ search: 'ada', page: 1 }),
          );
        },
        { timeout: 3000 },
      );
    });

    it('maps the Status filter onto ?status=', async () => {
      const user = userEvent.setup();
      setHookState({ entries: [pendingEntry], total: 1 });
      renderTable();

      await screen.findByText('pending@example.com');
      await pickOption(user, 'Value', 'Claimed');
      await user.click(screen.getByTestId('datatable-filter-apply'));

      await waitFor(() => {
        expect(mockFetchAllowlist).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'claimed' }),
        );
      });
    });

    it('sends sortBy/sortOrder only for the fields the endpoint accepts', async () => {
      const user = userEvent.setup();
      setHookState({ entries: [pendingEntry], total: 1 });
      renderTable();

      await screen.findByText('pending@example.com');
      await user.click(screen.getByRole('columnheader', { name: /^Email/ }));

      await waitFor(() => {
        expect(mockFetchAllowlist).toHaveBeenCalledWith(
          expect.objectContaining({ sortBy: 'email', sortOrder: 'asc' }),
        );
      });
    });

    it('offers no sort affordance on Added By or Notes — the service filters on neither', async () => {
      setHookState({ entries: [pendingEntry], total: 1 });
      renderTable();

      await screen.findByText('pending@example.com');
      for (const label of ['Added By', 'Notes']) {
        const header = screen.getByRole('columnheader', { name: new RegExp(`^${label}`) });
        expect(header).toHaveAttribute('aria-sort', 'none');
        expect(within(header).queryByRole('button')).not.toBeInTheDocument();
      }
    });
  });

  // =========================================================================
  // Removal — the confirm dialog that replaced window.confirm
  // =========================================================================

  describe('removal', () => {
    it('routes the remove action through the table’s own confirmation dialog', async () => {
      const user = userEvent.setup();
      setHookState({ entries: [pendingEntry], total: 1 });
      renderTable();

      await screen.findByText('pending@example.com');
      await user.click(
        screen.getByRole('button', { name: 'Remove for pending@example.com' }),
      );

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Remove from allowlist?')).toBeInTheDocument();
      expect(within(dialog).getByText(/pending@example\.com will no longer/i)).toBeInTheDocument();
      // Not yet — the dialog is a gate, not a receipt.
      expect(mockRemoveEmail).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
      await waitFor(() => expect(mockRemoveEmail).toHaveBeenCalledWith('entry-1'));
    });

    it('does not remove when the dialog is cancelled', async () => {
      const user = userEvent.setup();
      setHookState({ entries: [pendingEntry], total: 1 });
      renderTable();

      await screen.findByText('pending@example.com');
      await user.click(
        screen.getByRole('button', { name: 'Remove for pending@example.com' }),
      );

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(mockRemoveEmail).not.toHaveBeenCalled();
    });

    it('disables — rather than removes — the action on a claimed entry', async () => {
      setHookState({ entries: [claimedEntry], total: 1 });
      renderTable();

      await screen.findByText('claimed@example.com');
      // The control stays discoverable (and keeps its tooltip); the API refuses
      // this too, with a 400.
      expect(screen.getByRole('button', { name: 'Remove for claimed@example.com' })).toBeDisabled();
    });

    it('leaves the action enabled on a pending entry', async () => {
      setHookState({ entries: [pendingEntry], total: 1 });
      renderTable();

      await screen.findByText('pending@example.com');
      expect(
        screen.getByRole('button', { name: 'Remove for pending@example.com' }),
      ).toBeEnabled();
    });
  });

  // =========================================================================
  // The table-level action, now in the page header
  // =========================================================================

  describe('add email', () => {
    it('offers "Add Email" outside the table and opens its dialog', async () => {
      const user = userEvent.setup();
      renderTable();

      const addButton = screen.getByRole('button', { name: /add email/i });
      // It belongs to neither a row nor a selection, so it must not live inside
      // the table wrapper.
      expect(screen.getByTestId('admin-allowlist-table')).not.toContainElement(addButton);

      await user.click(addButton);
      expect(await screen.findByRole('dialog')).toHaveTextContent('Add Email to Allowlist');
    });

    it('adds the email through the hook', async () => {
      const user = userEvent.setup();
      renderTable();

      await user.click(screen.getByRole('button', { name: /add email/i }));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText(/email address/i), 'new@example.com');
      await user.click(within(dialog).getByRole('button', { name: /^add email$/i }));

      await waitFor(() =>
        expect(mockAddEmail).toHaveBeenCalledWith('new@example.com', undefined),
      );
    });
  });

  // =========================================================================
  // Permission gating — ABSENT from the DOM
  // =========================================================================

  describe('permission gating', () => {
    it('omits the remove action and the Add Email button without allowlist:write', async () => {
      setHookState({ entries: [pendingEntry], total: 1 });
      renderTable(['allowlist:read']);

      await screen.findByText('pending@example.com');
      expect(
        screen.queryByRole('button', { name: 'Remove for pending@example.com' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /add email/i })).not.toBeInTheDocument();
      // Not merely disabled — the whole Actions column is gone with the array.
      expect(
        screen.queryByRole('columnheader', { name: /^Actions/ }),
      ).not.toBeInTheDocument();
    });
  });
});
