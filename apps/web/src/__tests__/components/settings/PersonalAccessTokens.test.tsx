/**
 * Component tests — Settings → Personal access tokens, after the DataTable
 * migration (#67).
 *
 * Table mechanics are asserted once by `runDataTableConformanceSuite` and are
 * not repeated here; the suite is not invoked with these columns, whose cells
 * (text, a chip, monospace text) are all shapes the built-in fixture already
 * covers.
 *
 * Two page-specific properties get real coverage here because they are
 * decisions, not mechanics:
 *
 *  - **A CSV export must not contain token material.** `tokenPrefix` declares
 *    `exportable: false`, and the test below downloads the real file and reads
 *    it, rather than asserting the flag.
 *  - **PAT names are not unique**, so the row-unique scalar carries an
 *    id-derived suffix — otherwise twenty rows would offer twenty controls all
 *    announced as "Revoke for ci-token".
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser } from '../../utils/test-utils';
import { PersonalAccessTokens } from '../../../components/settings/PersonalAccessTokens';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../../components/datatable/__tests__/testUtils/layoutStubs';
import { api } from '../../../services/api';
import type { PersonalAccessToken, PatCreatedResponse } from '../../../types';

vi.mock('../../../hooks/usePersonalAccessTokens', () => ({
  usePersonalAccessTokens: vi.fn(),
}));

import { usePersonalAccessTokens } from '../../../hooks/usePersonalAccessTokens';

const mockUsePersonalAccessTokens = vi.mocked(usePersonalAccessTokens);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const activeToken: PersonalAccessToken = {
  id: 'pat-id-1',
  name: 'CI Pipeline',
  tokenPrefix: 'pat_ab12',
  durationValue: 30,
  durationUnit: 'days',
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  lastUsedAt: null,
  createdAt: new Date().toISOString(),
  revokedAt: null,
};

const expiredToken: PersonalAccessToken = {
  id: 'pat-id-2',
  name: 'Old Token',
  tokenPrefix: 'pat_cd34',
  durationValue: 7,
  durationUnit: 'days',
  expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  lastUsedAt: '2024-02-01T10:00:00Z',
  createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  revokedAt: null,
};

const revokedToken: PersonalAccessToken = {
  id: 'pat-id-3',
  name: 'Revoked Token',
  tokenPrefix: 'pat_ef56',
  durationValue: 90,
  durationUnit: 'days',
  expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
  lastUsedAt: null,
  createdAt: new Date().toISOString(),
  revokedAt: new Date(Date.now() - 3600000).toISOString(),
};

const createdResponse: PatCreatedResponse = {
  token: 'pat_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  id: 'pat-id-new',
  name: 'New Token',
  tokenPrefix: 'pat_abcd',
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  createdAt: new Date().toISOString(),
};

const mockFetchTokens = vi.fn();
const mockCreateToken = vi.fn();
const mockRevokeToken = vi.fn();

function setHookState({
  tokens = [] as PersonalAccessToken[],
  isLoading = false,
  error = null as string | null,
} = {}) {
  mockUsePersonalAccessTokens.mockReturnValue({
    tokens,
    isLoading,
    error,
    fetchTokens: mockFetchTokens,
    createToken: mockCreateToken,
    revokeToken: mockRevokeToken,
  });
}

function renderPats(width = 1400) {
  setInitialContainerWidth(width);
  return render(<PersonalAccessTokens />, { wrapperOptions: { user: mockUser } });
}

/** The accessible name a row's controls get: name + id-derived suffix. */
const rowLabel = (token: PersonalAccessToken) => `${token.name} (${token.id.slice(0, 8)})`;

// ---------------------------------------------------------------------------

describe('PersonalAccessTokens', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    vi.spyOn(api, 'get').mockResolvedValue({ dataTables: {} } as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
    mockCreateToken.mockResolvedValue(createdResponse);
    mockRevokeToken.mockResolvedValue(undefined);
    setHookState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Section chrome — kept, because it is the settings page's, not the table's
  // =========================================================================

  describe('section chrome', () => {
    it('keeps the card heading, description and Create Token button', () => {
      renderPats();

      expect(screen.getByText('Personal Access Tokens')).toBeInTheDocument();
      expect(
        screen.getByText('Create tokens to authenticate API requests without OAuth.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /create token/i })).toBeInTheDocument();
    });

    it('shows the empty state', async () => {
      renderPats();
      expect(
        await screen.findByText('No personal access tokens yet. Create one to get started.'),
      ).toBeInTheDocument();
    });

    it('shows an error alert', async () => {
      setHookState({ error: 'Failed to fetch tokens' });
      renderPats();
      expect(await screen.findByText('Failed to fetch tokens')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Column mapping
  // =========================================================================

  describe('rendering', () => {
    it('renders one row per token with the mapped columns', async () => {
      setHookState({ tokens: [activeToken, expiredToken, revokedToken] });
      renderPats();

      expect(await screen.findByText('CI Pipeline')).toBeInTheDocument();
      expect(screen.getByText('Old Token')).toBeInTheDocument();
      expect(screen.getByText('Revoked Token')).toBeInTheDocument();

      expect(screen.getByText('pat_ab12...')).toBeInTheDocument();
      expect(screen.getByText('Active')).toBeInTheDocument();
      expect(screen.getByText('Expired')).toBeInTheDocument();
      expect(screen.getByText('Revoked')).toBeInTheDocument();
    });

    it('renders "Never" for a token that has never been used', async () => {
      setHookState({ tokens: [activeToken] });
      renderPats();

      await screen.findByText('CI Pipeline');
      expect(screen.getByText('Never')).toBeInTheDocument();
    });

    it('keeps rows on screen underneath the loading overlay', async () => {
      setHookState({ tokens: [activeToken], isLoading: true });
      renderPats();

      expect(await screen.findByText('CI Pipeline')).toBeInTheDocument();
      expect(screen.getByTestId('datatable-loading-overlay')).toBeInTheDocument();
    });

    it('offers no sortable header — GET /api/pat accepts no query at all', async () => {
      setHookState({ tokens: [activeToken] });
      renderPats();

      await screen.findByText('CI Pipeline');
      for (const header of screen.getAllByRole('columnheader')) {
        expect(header).not.toHaveAttribute('aria-sort', 'ascending');
        expect(header).not.toHaveAttribute('aria-sort', 'descending');
      }
      // …and no filter surface, since nothing declares `filterable`.
      expect(screen.queryByTestId('datatable-filter-apply')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Non-unique names — the disambiguation decision
  // =========================================================================

  describe('name disambiguation', () => {
    it('gives two identically-named tokens distinct accessible names', async () => {
      const twin = { ...activeToken, id: 'pat-id-9', tokenPrefix: 'pat_zz99' };
      setHookState({ tokens: [activeToken, twin] });
      renderPats();

      await waitFor(() => expect(screen.getAllByText('CI Pipeline')).toHaveLength(2));

      // Both cells still READ "CI Pipeline" — the suffix is on the scalar only.
      const first = screen.getByRole('button', { name: `Revoke for ${rowLabel(activeToken)}` });
      const second = screen.getByRole('button', { name: `Revoke for ${rowLabel(twin)}` });
      expect(first).not.toBe(second);
    });
  });

  // =========================================================================
  // Revocation
  // =========================================================================

  describe('revocation', () => {
    it('routes revoke through the confirmation dialog', async () => {
      const user = userEvent.setup();
      setHookState({ tokens: [activeToken] });
      renderPats();

      await screen.findByText('CI Pipeline');
      await user.click(
        screen.getByRole('button', { name: `Revoke for ${rowLabel(activeToken)}` }),
      );

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Revoke token?')).toBeInTheDocument();
      expect(mockRevokeToken).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
      await waitFor(() => expect(mockRevokeToken).toHaveBeenCalledWith('pat-id-1'));
    });

    it('disables the action on an expired or revoked token rather than removing it', async () => {
      setHookState({ tokens: [expiredToken, revokedToken] });
      renderPats();

      await screen.findByText('Old Token');
      expect(
        screen.getByRole('button', { name: `Revoke for ${rowLabel(expiredToken)}` }),
      ).toBeDisabled();
      expect(
        screen.getByRole('button', { name: `Revoke for ${rowLabel(revokedToken)}` }),
      ).toBeDisabled();
    });
  });

  // =========================================================================
  // Create + reveal dialogs
  // =========================================================================

  describe('create token', () => {
    it('opens the create dialog and creates a token', async () => {
      const user = userEvent.setup();
      renderPats();

      await user.click(screen.getByRole('button', { name: /create token/i }));
      const dialog = await screen.findByRole('dialog');

      await user.type(within(dialog).getByLabelText(/token name/i), 'New Token');
      await user.click(within(dialog).getByRole('button', { name: /^create token$/i }));

      await waitFor(() =>
        expect(mockCreateToken).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'New Token' }),
        ),
      );
    });

    it('reveals the created token value afterwards', async () => {
      const user = userEvent.setup();
      renderPats();

      await user.click(screen.getByRole('button', { name: /create token/i }));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText(/token name/i), 'New Token');
      await user.click(within(dialog).getByRole('button', { name: /^create token$/i }));

      // The reveal dialog puts the value in a read-only field, not a text node.
      await waitFor(() =>
        expect(screen.getByDisplayValue(createdResponse.token)).toBeInTheDocument(),
      );
    });
  });

  // =========================================================================
  // CSV export must not carry token material
  // =========================================================================

  describe('CSV export', () => {
    let lastBlob: Blob | null = null;
    let clickSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      lastBlob = null;
      URL.createObjectURL = vi.fn((blob: Blob) => {
        lastBlob = blob;
        return 'blob:mock';
      }) as unknown as typeof URL.createObjectURL;
      URL.revokeObjectURL = vi.fn();
      clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    });

    afterEach(() => {
      clickSpy.mockRestore();
    });

    /**
     * A downloaded CSV outlives the session that produced it: it lands in a
     * downloads folder, gets mailed around, and survives the token and often
     * the employment. Truncated or not, token material has no business in a
     * document with that lifetime — so `tokenPrefix` declares
     * `exportable: false` and this reads the real file to prove it.
     */
    it('omits the token prefix — column and values — from the downloaded file', async () => {
      setHookState({ tokens: [activeToken, expiredToken] });
      renderPats();

      await screen.findByText('CI Pipeline');
      fireEvent.click(screen.getByTestId('datatable-export-button'));
      await waitFor(() => expect(lastBlob).not.toBeNull());

      const text = await (lastBlob as unknown as Blob).text();

      // The rows really are in the file…
      expect(text).toContain('CI Pipeline');
      expect(text).toContain('Old Token');
      // …and the token material really is not.
      expect(text).not.toContain('Token Prefix');
      expect(text).not.toContain('pat_ab12');
      expect(text).not.toContain('pat_cd34');
    });
  });
});
