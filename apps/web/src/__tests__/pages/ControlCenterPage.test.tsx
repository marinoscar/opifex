/**
 * The Control Center — `/admin/settings` (#347, epic #332).
 *
 * The describe blocks below deliberately mirror the ones in the deleted
 * `SystemSettingsPage.test.tsx` — authorization, loading, error, navigation,
 * version, save, disabled state — because replacing a page from scratch must
 * not quietly cost it coverage it already had. Several of the originals were
 * vacuous (`// Feature flags should be visible` with no assertion after it, an
 * `expect(updateSettings).toBeDefined()`), so the blocks are the same and the
 * assertions inside them are not.
 *
 * `useSystemSettings` and `usePermissions` are mocked, as they were before.
 * `useReadiness` is NOT: it runs for real against MSW, because the readiness
 * chain's whole claim is that it renders what an endpoint said, and a mocked
 * hook would let that claim be true of nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { render, mockAdminUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import ControlCenterPage from '../../pages/ControlCenterPage';

vi.mock('../../hooks/useSystemSettings', () => ({
  useSystemSettings: vi.fn(),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { useSystemSettings } from '../../hooks/useSystemSettings';
import { usePermissions } from '../../hooks/usePermissions';

const mockUseSystemSettings = vi.mocked(useSystemSettings);
const mockUsePermissions = vi.mocked(usePermissions);

const API_BASE = '*/api';

function settingsResult(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
      ui: { allowUserThemeOverride: true },
      features: {},
      updatedAt: new Date().toISOString(),
      updatedBy: null,
      version: 1,
    },
    isLoading: false,
    error: null,
    isSaving: false,
    updateSettings: vi.fn().mockResolvedValue(undefined),
    replaceSettings: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useSystemSettings>;
}

function permissions(granted: string[], isAdmin = true) {
  return {
    permissions: new Set(granted),
    roles: new Set(isAdmin ? ['admin'] : ['viewer']),
    hasPermission: (perm: string) => granted.includes(perm),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin,
  } as unknown as ReturnType<typeof usePermissions>;
}

/** The page waits for the settings fetch before drawing anything. */
async function awaitPage() {
  await waitFor(() =>
    expect(
      screen.getByRole('heading', { name: /control center/i, level: 1 }),
    ).toBeInTheDocument(),
  );
}

/** Move to the section that holds the theme override. */
async function openInterface(user: ReturnType<typeof userEvent.setup>) {
  await awaitPage();
  await user.click(screen.getByRole('tab', { name: /interface/i }));
  // `role="switch"`, not `checkbox`: MUI 9's Switch sets it on the input.
  return screen.findByRole('switch', {
    name: /allow users to choose their own theme/i,
  });
}

describe('ControlCenterPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(
      permissions(['system_settings:read', 'system_settings:write']),
    );
    mockUseSystemSettings.mockReturnValue(settingsResult());
  });

  describe('Authorization', () => {
    it('redirects a user without system_settings:read', () => {
      mockUsePermissions.mockReturnValue(
        permissions(['user_settings:read'], false),
      );

      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(
        screen.queryByRole('heading', { name: /control center/i }),
      ).not.toBeInTheDocument();
    });

    it('does not even fetch the settings for a user it redirects', () => {
      // The gate is split from the body precisely so the redirect happens
      // before any data hook runs — firing a request certain to 403 teaches
      // the operator nothing and puts a 403 in the API log for a page they
      // never saw.
      mockUsePermissions.mockReturnValue(
        permissions(['user_settings:read'], false),
      );

      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(mockUseSystemSettings).not.toHaveBeenCalled();
    });

    it('loads for an administrator', async () => {
      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });
      await awaitPage();
    });

    it('renders read-only for system_settings:read without :write', async () => {
      mockUsePermissions.mockReturnValue(
        permissions(['system_settings:read'], false),
      );
      const user = userEvent.setup();

      render(<ControlCenterPage />, {
        wrapperOptions: {
          user: {
            ...mockAdminUser,
            roles: [{ name: 'viewer' }],
            permissions: ['system_settings:read'],
          },
        },
      });

      await awaitPage();
      expect(screen.getByText(/read-only/i)).toBeInTheDocument();

      const toggle = await openInterface(user);
      expect(toggle).toBeDisabled();
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
      expect(screen.getByText(/system_settings:write/)).toBeInTheDocument();
    });
  });

  describe('Loading State', () => {
    it('shows a spinner while the settings are being fetched', () => {
      mockUseSystemSettings.mockReturnValue(
        settingsResult({ settings: null, isLoading: true }),
      );

      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  describe('Error Display', () => {
    it('displays the settings error', async () => {
      mockUseSystemSettings.mockReturnValue(
        settingsResult({
          settings: null,
          error: 'Failed to load system settings',
        }),
      );

      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() =>
        expect(
          screen.getByText(/failed to load system settings/i),
        ).toBeInTheDocument(),
      );
    });
  });

  describe('Section navigation', () => {
    it('offers every declared section as a tab', async () => {
      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });
      await awaitPage();

      for (const label of [
        'Readiness',
        'Interface',
        'Configuration',
        'Credentials',
        'Repositories',
        'History',
      ]) {
        expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
      }
    });

    it('opens Readiness by default', async () => {
      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });
      await awaitPage();

      expect(screen.getByRole('tab', { name: 'Readiness' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('switches section on click', async () => {
      const user = userEvent.setup();
      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });
      await awaitPage();

      await user.click(screen.getByRole('tab', { name: 'History' }));

      expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('deep-links a section from ?section=', async () => {
      render(<ControlCenterPage />, {
        wrapperOptions: {
          user: mockAdminUser,
          route: '/admin/settings?section=credentials',
        },
      });
      await awaitPage();

      expect(screen.getByRole('tab', { name: 'Credentials' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('falls back to Readiness when ?section= names nothing', async () => {
      render(<ControlCenterPage />, {
        wrapperOptions: {
          user: mockAdminUser,
          route: '/admin/settings?section=was-renamed',
        },
      });
      await awaitPage();

      expect(screen.getByRole('tab', { name: 'Readiness' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('renders a planned section as not built, naming its issue', async () => {
      const user = userEvent.setup();
      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });
      await awaitPage();

      await user.click(screen.getByRole('tab', { name: 'Repositories' }));

      expect(
        await screen.findByText(/Repositories is not built yet/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/#350/)).toBeInTheDocument();
      expect(
        screen.getByText(/Arrives in Phase 5 — Cockpit/),
      ).toBeInTheDocument();
    });
  });

  describe('Readiness', () => {
    it('renders the runbook chain, in order', async () => {
      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });
      await awaitPage();

      const steps = await screen.findAllByRole('listitem');
      expect(steps.map((item) => item.getAttribute('aria-label'))).toEqual([
        'Step 1: The binaries are installed',
        'Step 2: The credential authenticates',
        'Step 3: The runner is enabled and dispatchable',
        'Step 4: Dispatch is enabled',
        'Step 5: At least one repository may be dispatched into',
      ]);
    });

    it('shows configured beside observed for the runner', async () => {
      // The default fixture is the runbook's own recorded payload:
      // `available: true` next to `enabled: 0`. This is the sentence the epic
      // says is the most useful thing this screen can say.
      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });
      await awaitPage();

      const card = await screen.findByLabelText(
        'Step 3: The runner is enabled and dispatchable',
      );
      expect(within(card).getByText(/available: true/)).toBeInTheDocument();
      expect(within(card).getByText(/enabled: 0/)).toBeInTheDocument();
      // BOTH halves cite the endpoint that produced them — two occurrences,
      // not one. A fact whose origin is not stated is a claim nobody can check.
      expect(
        within(card).getAllByText('GET /api/health/ready → info.fleet'),
      ).toHaveLength(2);
    });

    it('explains once, at the top, why two steps are not green', async () => {
      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });
      await awaitPage();

      expect(
        await screen.findByText(
          /2 steps have no probe behind them yet, so they are reported as not yet verifiable rather than assumed/i,
        ),
      ).toBeInTheDocument();
    });

    it('reports the credential and dispatch as not yet verifiable', async () => {
      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });
      await awaitPage();

      for (const label of [
        'Step 2: The credential authenticates',
        'Step 4: Dispatch is enabled',
      ]) {
        const card = await screen.findByLabelText(label);
        expect(
          within(card).getByText('Not yet verifiable'),
        ).toBeInTheDocument();
      }
    });

    it('reads the repository count from the repositories endpoint', async () => {
      server.use(
        http.get(`${API_BASE}/repositories`, ({ request }) => {
          const url = new URL(request.url);
          const total =
            url.searchParams.get('dispatchEnabled') === 'true' ? 1 : 4;
          return HttpResponse.json({
            data: { items: [], total, page: 1, pageSize: 1 },
          });
        }),
      );

      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });
      await awaitPage();

      const card = await screen.findByLabelText(
        'Step 5: At least one repository may be dispatched into',
      );
      await waitFor(() =>
        expect(within(card).getByText('1 of 4 registered')).toBeInTheDocument(),
      );
      expect(within(card).getByText('Verified')).toBeInTheDocument();
    });

    it('says a forbidden repository read is not verifiable, never zero', async () => {
      server.use(
        http.get(`${API_BASE}/repositories`, () =>
          HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
        ),
      );

      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });
      await awaitPage();

      const card = await screen.findByLabelText(
        'Step 5: At least one repository may be dispatched into',
      );
      await waitFor(() =>
        expect(within(card).getByText('Could not read')).toBeInTheDocument(),
      );
      expect(within(card).getByText(/projects:read/)).toBeInTheDocument();
    });

    it('navigates to the section that fixes a step', async () => {
      const user = userEvent.setup();
      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });
      await awaitPage();

      const card = await screen.findByLabelText(
        'Step 5: At least one repository may be dispatched into',
      );
      await user.click(
        within(card).getByRole('button', { name: /enable a repository/i }),
      );

      expect(screen.getByRole('tab', { name: 'Repositories' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
  });

  describe('Version Display', () => {
    it('shows who last changed the settings, and the document version', async () => {
      mockUseSystemSettings.mockReturnValue(
        settingsResult({
          settings: {
            ui: { allowUserThemeOverride: true },
            features: {},
            updatedAt: new Date('2024-01-15T10:30:00Z').toISOString(),
            updatedBy: { id: 'admin-id', email: 'admin@example.com' },
            version: 7,
          },
        }),
      );

      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });
      await awaitPage();

      expect(screen.getByText(/admin@example\.com/)).toBeInTheDocument();
      expect(
        screen.getByText(/System settings document version 7/),
      ).toBeInTheDocument();
    });

    it('omits the attribution when nothing has been changed yet', async () => {
      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });
      await awaitPage();

      expect(screen.queryByText(/last updated by/i)).not.toBeInTheDocument();
    });
  });

  describe('Save Functionality', () => {
    it('sends the theme policy nested under ui', async () => {
      const updateSettings = vi.fn().mockResolvedValue(undefined);
      mockUseSystemSettings.mockReturnValue(settingsResult({ updateSettings }));
      const user = userEvent.setup();

      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const toggle = await openInterface(user);
      await user.click(toggle);
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      // The nesting is load-bearing: `PATCH /api/system-settings` merges by
      // namespace, and a flat `{ allowUserThemeOverride }` would be rejected.
      await waitFor(() =>
        expect(updateSettings).toHaveBeenCalledWith({
          ui: { allowUserThemeOverride: false },
        }),
      );
    });

    it('reports a save by what the API returned, not by what was asked for', async () => {
      const user = userEvent.setup();
      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const toggle = await openInterface(user);
      await user.click(toggle);
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      expect(
        await screen.findByText(/the api returned the updated document/i),
      ).toBeInTheDocument();
    });

    it('surfaces a failed save instead of leaving the switch looking applied', async () => {
      const updateSettings = vi
        .fn()
        .mockRejectedValue(new Error('Settings were updated elsewhere'));
      mockUseSystemSettings.mockReturnValue(settingsResult({ updateSettings }));
      const user = userEvent.setup();

      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const toggle = await openInterface(user);
      await user.click(toggle);
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      expect(
        await screen.findByText(/settings were updated elsewhere/i),
      ).toBeInTheDocument();
    });

    it('will not save when nothing changed', async () => {
      const user = userEvent.setup();
      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await openInterface(user);
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    });
  });

  describe('The theme policy reaches /auth/me consumers', () => {
    it('re-reads /auth/me after a successful save rather than inferring', async () => {
      // #79/#211: `allowUserThemeOverride` existed, had an admin UI, and
      // NOTHING honoured it. It reaches users on `/auth/me` — it cannot be
      // fetched from `/api/system-settings`, which 403s for exactly the
      // population it constrains. So the only honest way to show the new value
      // is to re-read that endpoint. Inferring it locally would put the
      // administrator's own screen back in the state the bug describes.
      const refreshUser = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();

      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser, refreshUser },
      });

      const toggle = await openInterface(user);
      await user.click(toggle);
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(refreshUser).toHaveBeenCalledTimes(1));
    });

    it('does not re-read when the save failed', async () => {
      const refreshUser = vi.fn().mockResolvedValue(undefined);
      mockUseSystemSettings.mockReturnValue(
        settingsResult({
          updateSettings: vi.fn().mockRejectedValue(new Error('409')),
        }),
      );
      const user = userEvent.setup();

      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser, refreshUser },
      });

      const toggle = await openInterface(user);
      await user.click(toggle);
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await screen.findByText(/409/);
      expect(refreshUser).not.toHaveBeenCalled();
    });

    it('states how the flag reaches users instead of claiming it is live', async () => {
      const user = userEvent.setup();
      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await openInterface(user);
      expect(
        screen.getByText(/sessions already open keep the old value/i),
      ).toBeInTheDocument();
    });
  });

  describe('Disabled State', () => {
    it('disables the controls while a save is in flight', async () => {
      mockUseSystemSettings.mockReturnValue(settingsResult({ isSaving: true }));
      const user = userEvent.setup();

      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const toggle = await openInterface(user);
      expect(toggle).toBeDisabled();
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    });

    it('keeps a saving state distinct from a permission refusal', async () => {
      // `disabled` conflates "no system_settings:write" with "a save is in
      // flight", so the EXPLANATION must not: an in-flight save is temporary
      // and needs no sentence, a missing permission is permanent and does.
      mockUseSystemSettings.mockReturnValue(settingsResult({ isSaving: true }));
      const user = userEvent.setup();

      render(<ControlCenterPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await openInterface(user);
      expect(
        screen.queryByText(/system_settings:write/),
      ).not.toBeInTheDocument();
    });
  });
});
