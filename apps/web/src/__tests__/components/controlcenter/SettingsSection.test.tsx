/**
 * The Configuration section, rendered from a real response (#348, epic #332).
 *
 * `SettingsSectionContainer` is exercised rather than `SettingsSection`, so
 * `useOperatorSettings`, `services/api` and MSW are all in the path: the claim
 * this section makes is that it renders what the endpoint said and sends only
 * what changed, and both halves of that are about a request. Mocking the hook
 * would let the claim be true of nothing.
 *
 * The two tests that carry the issue's acceptance criteria are
 * "renders a key this build has never heard of" and "sends only the keys that
 * changed". The rest are the states the section has to get right around them.
 */

import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { render } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import {
  OPERATOR_SETTINGS_FIXTURE,
  operatorSettingsFixture,
} from '../../mocks/operatorSettings';
import { SettingsSectionContainer } from '../../../components/controlcenter/SettingsSectionContainer';
import type {
  OperatorSetting,
  OperatorSettingsDocument,
} from '../../../types/operatorSettings';

const API_BASE = '*/api';

const FLEET = {
  status: 'up',
  checked: true,
  runners: [
    {
      key: 'claude-code-local',
      version: '2.1.246',
      enabled: false,
      available: true,
      maxConcurrency: 2,
    },
  ],
};

interface Harness {
  onSaved: ReturnType<typeof vi.fn>;
  onSaveError: ReturnType<typeof vi.fn>;
}

function renderSection(
  options: { canWrite?: boolean; fleet?: typeof FLEET | null } = {},
): Harness {
  const onSaved = vi.fn();
  const onSaveError = vi.fn();

  render(
    <SettingsSectionContainer
      canWrite={options.canWrite ?? true}
      fleet={options.fleet === undefined ? FLEET : options.fleet}
      onSaved={onSaved}
      onSaveError={onSaveError}
    />,
  );

  return { onSaved, onSaveError };
}

/** Serve this document instead of the default fixture. */
function serve(document: OperatorSettingsDocument) {
  server.use(
    http.get(`${API_BASE}/operator-settings`, () =>
      HttpResponse.json({ data: document }),
    ),
  );
}

/**
 * Capture what a save actually sends.
 *
 * The recorded body IS the assertion for the sparse-patch criterion, so it is
 * read off the request rather than off any spy the component was handed.
 */
function recordPatch() {
  const seen: { body: Record<string, unknown> | null; ifMatch: string | null } =
    { body: null, ifMatch: null };

  server.use(
    http.patch(`${API_BASE}/operator-settings`, async ({ request }) => {
      seen.body = (await request.json()) as Record<string, unknown>;
      seen.ifMatch = request.headers.get('If-Match');
      return HttpResponse.json({
        data: operatorSettingsFixture({ revision: 8 }),
      });
    }),
  );

  return seen;
}

/** The row for a key, by the `aria-label` every row carries. */
async function row(key: string) {
  return screen.findByLabelText(key);
}

describe('SettingsSection', () => {
  describe('Generated from the registry response', () => {
    it('renders every key the response carried, grouped', async () => {
      renderSection();

      for (const entry of OPERATOR_SETTINGS_FIXTURE) {
        expect(await row(entry.key)).toBeInTheDocument();
      }
      expect(
        screen.getByRole('heading', { name: 'GitHub' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: 'Execution' }),
      ).toBeInTheDocument();
    });

    it('renders a key and a group this build has never heard of', async () => {
      // The acceptance criterion, stated as a test: adding a key in the
      // backend registry must need no edit in apps/web. Nothing in this key,
      // its group or its label appears anywhere in the frontend source.
      const invented: OperatorSetting = {
        key: 'weather.forecastHorizonDays',
        group: 'weather_service',
        label: 'Forecast horizon',
        help: 'How far ahead the forecast is fetched.',
        type: 'integer',
        reload: 'live',
        dangerous: false,
        source: 'env',
        envVar: 'WEATHER_FORECAST_HORIZON_DAYS',
        acceptsNull: false,
        updatedAt: null,
        constraints: { min: 1, max: 14 },
        secret: false,
        value: 7,
        default: 3,
      };

      serve(
        operatorSettingsFixture({
          settings: [...OPERATOR_SETTINGS_FIXTURE, invented],
        }),
      );
      renderSection();

      const card = await row('weather.forecastHorizonDays');
      expect(
        screen.getByRole('heading', { name: 'Weather service' }),
      ).toBeInTheDocument();
      expect(within(card).getByLabelText('Forecast horizon')).toHaveValue(7);
      expect(within(card).getByText('live')).toBeInTheDocument();
    });

    it('renders all three reload states, each from the API', async () => {
      renderSection();

      expect(
        within(await row('github.requestTimeoutMs')).getByText('live'),
      ).toBeInTheDocument();
      expect(
        within(await row('runners.claudeCodeLocal.permissionMode')).getByText(
          'applies to new runs',
        ),
      ).toBeInTheDocument();
      expect(
        within(await row('github.apiBaseUrl')).getByText('restart required'),
      ).toBeInTheDocument();
    });

    it('shows provenance for each of the three sources', async () => {
      renderSection();

      expect(
        within(await row('github.requestTimeoutMs')).getByText(
          'overridden here',
        ),
      ).toBeInTheDocument();
      expect(
        within(await row('runners.claudeCodeLocal.enabled')).getByText(
          'from environment',
        ),
      ).toBeInTheDocument();
      expect(
        within(await row('github.apiBaseUrl')).getByText('built-in default'),
      ).toBeInTheDocument();
    });

    it('shows the observed counterpart beside the configured value', async () => {
      renderSection();

      const card = await row('runners.claudeCodeLocal.enabled');
      expect(
        within(card).getByText('claude-code-local enabled: false'),
      ).toBeInTheDocument();
      expect(
        within(card).getByText('GET /api/health/ready → info.fleet'),
      ).toBeInTheDocument();
      // Configured true, observed false. Both are shown and neither is derived
      // from the other.
      expect(within(card).getByRole('switch')).toBeChecked();
    });
  });

  describe('Saving', () => {
    it('sends only the keys that changed', async () => {
      const seen = recordPatch();
      const user = userEvent.setup();
      renderSection();

      const card = await row('github.requestTimeoutMs');
      const field = within(card).getByLabelText('GitHub request timeout');
      await user.clear(field);
      await user.type(field, '20000');

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(seen.body).not.toBeNull());
      // The whole criterion is in `Object.keys`: five other keys are on
      // screen, all of them rendered as controls, and none of them may travel.
      expect(Object.keys(seen.body ?? {})).toEqual(['github.requestTimeoutMs']);
      expect(seen.body).toEqual({ 'github.requestTimeoutMs': 20000 });
    });

    it('carries the document revision as If-Match', async () => {
      const seen = recordPatch();
      const user = userEvent.setup();
      renderSection();

      const card = await row('runners.claudeCodeLocal.enabled');
      await user.click(within(card).getByRole('switch'));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(seen.body).not.toBeNull());
      expect(seen.ifMatch).toBe('7');
    });

    it('sends null for a revert to environment', async () => {
      const seen = recordPatch();
      const user = userEvent.setup();
      renderSection();

      const card = await row('github.requestTimeoutMs');
      await user.click(
        within(card).getByRole('button', { name: /revert to environment/i }),
      );
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(seen.body).not.toBeNull());
      expect(seen.body).toEqual({ 'github.requestTimeoutMs': null });
    });

    it('stores an explicit null as the string null, not as the revert', async () => {
      // Clearing a ceiling of 4 means "no ceiling", which is a stored value.
      // The revert is JSON null and deletes the row; the two are opposite
      // intentions and the API distinguishes them by exactly this.
      serve(
        operatorSettingsFixture({
          settings: OPERATOR_SETTINGS_FIXTURE.map((entry) =>
            entry.key === 'dispatch.maxConcurrent' && !entry.secret
              ? { ...entry, value: 4, source: 'database' as const }
              : entry,
          ),
        }),
      );
      const seen = recordPatch();
      const user = userEvent.setup();
      renderSection();

      const card = await row('dispatch.maxConcurrent');
      await user.clear(
        within(card).getByLabelText('Maximum concurrent dispatches'),
      );
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(seen.body).not.toBeNull());
      expect(seen.body).toEqual({ 'dispatch.maxConcurrent': 'null' });
    });

    it('drops the draft once the API has answered with a new document', async () => {
      recordPatch();
      const user = userEvent.setup();
      renderSection();

      const card = await row('runners.claudeCodeLocal.enabled');
      await user.click(within(card).getByRole('switch'));
      expect(screen.getByText(/1 key will be sent/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      // The response is the registry re-resolved, so every draft against the
      // previous document is spent. Re-seeded during render, not in an effect.
      await waitFor(() =>
        expect(screen.getByText('No changes to send.')).toBeInTheDocument(),
      );
    });

    it('shows the key as coming from the environment once the revert lands', async () => {
      // The API re-resolves after the write and this renders THAT, rather than
      // inferring what a deleted row falls back to. What `GITHUB_REQUEST_TIMEOUT_MS`
      // says is not knowable here, which is the whole reason for re-reading.
      server.use(
        http.patch(`${API_BASE}/operator-settings`, () =>
          HttpResponse.json({
            data: operatorSettingsFixture({
              revision: 8,
              settings: OPERATOR_SETTINGS_FIXTURE.map((entry) =>
                entry.key === 'github.requestTimeoutMs' && !entry.secret
                  ? {
                      ...entry,
                      value: 10000,
                      source: 'env' as const,
                      updatedAt: null,
                    }
                  : entry,
              ),
            }),
          }),
        ),
      );
      const user = userEvent.setup();
      renderSection();

      const card = await row('github.requestTimeoutMs');
      expect(within(card).getByText('overridden here')).toBeInTheDocument();

      await user.click(
        within(card).getByRole('button', { name: /revert to environment/i }),
      );
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() =>
        expect(
          within(screen.getByLabelText('github.requestTimeoutMs')).getByText(
            'from environment',
          ),
        ).toBeInTheDocument(),
      );
    });

    it('offers no revert for a key that has no stored row to delete', async () => {
      renderSection();

      // `runners.claudeCodeLocal.enabled` comes from the environment. Reverting
      // it would delete nothing, so the control is not offered as if it would.
      const card = await row('runners.claudeCodeLocal.enabled');
      expect(
        within(card).getByRole('button', { name: /revert to environment/i }),
      ).toBeDisabled();
    });

    it('keeps the Save button dead until something changes', async () => {
      const user = userEvent.setup();
      renderSection();

      const save = await screen.findByRole('button', { name: /save changes/i });
      expect(save).toBeDisabled();

      const card = await row('runners.claudeCodeLocal.enabled');
      await user.click(within(card).getByRole('switch'));

      expect(save).toBeEnabled();
    });

    it('refuses to send a value the constraints reject, and says which', async () => {
      const user = userEvent.setup();
      renderSection();

      const card = await row('github.requestTimeoutMs');
      const field = within(card).getByLabelText('GitHub request timeout');
      await user.clear(field);
      await user.type(field, '12');

      expect(
        within(card).getByText(/has to be at least 1000/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /save changes/i }),
      ).toBeDisabled();
    });

    it('names the keys that are stored but not yet in force', async () => {
      recordPatch();
      const user = userEvent.setup();
      const { onSaved } = renderSection();

      const card = await row('github.apiBaseUrl');
      const field = within(card).getByLabelText('GitHub API base URL');
      await user.clear(field);
      await user.type(field, 'https://ghe.example.com/api/v3');
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(onSaved.mock.calls[0][0]).toContain('needs an API restart');
    });

    it('re-reads and explains when the revision went stale', async () => {
      server.use(
        http.patch(`${API_BASE}/operator-settings`, () =>
          HttpResponse.json(
            { message: 'These settings changed since you read them' },
            { status: 409 },
          ),
        ),
      );
      const user = userEvent.setup();
      const { onSaveError } = renderSection();

      const card = await row('runners.claudeCodeLocal.enabled');
      await user.click(within(card).getByRole('switch'));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(onSaveError).toHaveBeenCalled());
      expect(onSaveError.mock.calls[0][0]).toContain('nothing');
      expect(onSaveError.mock.calls[0][0]).toMatch(/re-read/i);
    });
  });

  describe('The overlay banner', () => {
    it('says the environment is what is in force when status is not loaded', async () => {
      serve(
        operatorSettingsFixture({
          revision: null,
          status: 'unavailable',
          overlay: {
            loadedAt: null,
            attemptedAt: '2026-08-01T10:00:15.000Z',
            overriddenKeys: 0,
            warning: 'operator_settings_overlay_unavailable',
            problem: 'Connection refused reaching the database.',
          },
        }),
      );
      renderSection();

      expect(
        await screen.findByText(/being served from the environment/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Connection refused reaching the database/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/has not loaded in this process/i),
      ).toBeInTheDocument();
    });

    it('says nothing of the kind when the overlay loaded', async () => {
      renderSection();

      await row('github.token');
      expect(
        screen.queryByText(/being served from the environment/i),
      ).not.toBeInTheDocument();
    });
  });

  describe('Secrets', () => {
    it('renders a secret read-only, with the mask and where rotation lives', async () => {
      renderSection();

      const card = await row('github.token');
      expect(within(card).getByText('********cdef')).toBeInTheDocument();
      expect(within(card).queryByRole('textbox')).not.toBeInTheDocument();
      // #349 landed, so the row points at the section that owns rotation
      // rather than at an issue number.
      expect(within(card).getByText(/Credentials/)).toBeInTheDocument();
      expect(
        within(card).queryByRole('button', { name: /revert to environment/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe('Read-only', () => {
    it('disables every control for an account without the write permission', async () => {
      renderSection({ canWrite: false });

      const card = await row('github.requestTimeoutMs');
      expect(
        within(card).getByLabelText('GitHub request timeout'),
      ).toBeDisabled();
      expect(
        within(card).getByRole('button', { name: /revert to environment/i }),
      ).toBeDisabled();
      expect(
        screen.getByRole('button', { name: /save changes/i }),
      ).toBeDisabled();
      expect(screen.getByText(/system_settings:write/)).toBeInTheDocument();
    });
  });

  describe('The read itself', () => {
    it('reports a failed read rather than rendering an empty registry', async () => {
      server.use(
        http.get(`${API_BASE}/operator-settings`, () =>
          HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
        ),
      );
      renderSection();

      expect(
        await screen.findByText(/may not read operator settings/i),
      ).toBeInTheDocument();
    });
  });
});
