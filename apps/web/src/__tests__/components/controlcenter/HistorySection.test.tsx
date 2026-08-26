/**
 * History — the Control Center's change log (#351, epic #332).
 *
 * Rendered at a phone-width CONTAINER for the row assertions so the DataTable
 * resolves to its card renderer, following `TrustPage.test.tsx`: a card is one
 * DOM node per row, which makes a row assertion an assertion about ROWS rather
 * than about a virtualized grid's viewport. The filter assertions run at a
 * desktop width, where the filter editor is on screen rather than behind a
 * sheet.
 *
 * MSW serves `apps/web/src/__tests__/mocks/handlers.ts`'s audit fixtures,
 * which are the API's OWN serialization — `{ data: { items, total, … } }`,
 * with `meta` already redacted and a masked value keeping the last four
 * characters `maskSecret` reveals. A handler that echoed the request back
 * would hand this component a shape the real API never produces.
 *
 * The load-bearing test in this file is `renders no credential-shaped text`.
 * It is the DOM counterpart of the whole-response grep #338 runs server-side,
 * and it is deliberately a grep over `document.body.textContent` rather than a
 * check of one cell: the claim is about the SCREEN, and a future column that
 * printed `meta` raw would pass any narrower assertion.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render, mockAdminUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import {
  installLayoutStubs,
  setInitialContainerWidth,
} from '../../../components/datatable/__tests__/testUtils/layoutStubs';
import { HistorySection } from '../../../components/controlcenter/HistorySection';

const API = '*/api';
const CARD_WIDTH = 400;
const DESKTOP_WIDTH = 1400;

/** A real GitHub token shape and a real Anthropic key shape. */
const PLAINTEXT_TOKEN = 'ghp_Kx7Vd2Nq9Zb4Mr6Wt3Jc8Ly5Hs';
const PLAINTEXT_KEY = 'sk-ant-api03-0Vb7Qn4Xz2Lp9Rk1';

function renderSection(width = CARD_WIDTH) {
  setInitialContainerWidth(width);
  return render(<HistorySection />, {
    wrapperOptions: { user: mockAdminUser },
  });
}

/** Resolves once the first page of the audit log is on screen. */
async function awaitRows() {
  await screen.findAllByText('operator_settings:set');
}

describe('HistorySection', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setInitialContainerWidth(CARD_WIDTH);
  });

  describe('what a row says', () => {
    it('renders actor, action, target and when, for each row', async () => {
      renderSection();
      await awaitRows();

      // The four facts #351 asks for, on the row that changed dispatch.
      expect(screen.getByText('dispatch.enabled')).toBeInTheDocument();
      expect(screen.getAllByText('Admin User').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Operator settings').length).toBe(3);
      expect(screen.getAllByText('operator_settings:set')).toHaveLength(2);
      expect(screen.getByText('operator_settings:clear')).toBeInTheDocument();
    });

    it('renders a non-secret change as a before and an after', async () => {
      renderSection();
      await awaitRows();

      expect(screen.getByText('false')).toBeInTheDocument();
      expect(screen.getByText('true')).toBeInTheDocument();
      // Where each side resolved from. Clearing a database row reverts to
      // whatever the environment says, so the layer is half of what the change
      // means (ADR-0018 §2).
      expect(screen.getByText('(default)')).toBeInTheDocument();
      expect(screen.getAllByText('(database)').length).toBeGreaterThan(0);
    });

    it('keeps a deleted actor apart from no actor at all', async () => {
      renderSection();
      await awaitRows();

      // `onDelete: SetNull` left the id on the row without a user...
      expect(screen.getByText('Deleted account')).toBeInTheDocument();
      // ...and this one had no actor to begin with: nothing human did it.
      expect(screen.getByText('Opifex itself')).toBeInTheDocument();
    });

    it('renders a writer that records no before-state without inventing one', async () => {
      renderSection();
      await awaitRows();

      const email = screen.getByText('newcomer@example.com');
      expect(email).toBeInTheDocument();
      // No arrow: `{ email }` is what the allowlist recorded, and
      // "not set → newcomer@example.com" would assert a previous value.
      expect(email.textContent).not.toContain('→');
    });
  });

  describe('secrets', () => {
    it('says a secret was set, and says nothing else about it', async () => {
      renderSection();
      await awaitRows();

      expect(screen.getByText('Secret set')).toBeInTheDocument();
      expect(screen.getByText('Secret cleared')).toBeInTheDocument();
      // The key is a name and is safe; the value is what is withheld.
      expect(screen.getByText('github.token')).toBeInTheDocument();
    });

    it('renders no credential-shaped text anywhere in the DOM', async () => {
      // The DOM counterpart of #338's whole-response grep. The fixture here is
      // deliberately WORSE than anything the API can serve: one row carries a
      // plaintext token under a secret-named key, another a plaintext API key
      // under a field the API's denylist would have masked. If the UI ever
      // becomes an echo of the server's redaction, this fails.
      server.use(
        http.get(`${API}/audit-events`, () =>
          HttpResponse.json({
            data: {
              items: [
                auditRow({
                  id: 'r1',
                  targetId: 'github.token',
                  meta: {
                    key: 'github.token',
                    from: null,
                    to: PLAINTEXT_TOKEN,
                  },
                }),
                auditRow({
                  id: 'r2',
                  targetId: 'supervisor.model.apiKey',
                  meta: {
                    key: 'supervisor.model.apiKey',
                    from: '********',
                    to: '********9Rk1',
                  },
                }),
                auditRow({
                  id: 'r3',
                  action: 'user:update',
                  targetType: 'user',
                  targetId: 'u1',
                  meta: { apiKey: PLAINTEXT_KEY, displayName: 'Ada' },
                }),
              ],
              total: 3,
              page: 1,
              pageSize: 25,
              totalPages: 1,
            },
          }),
        ),
      );

      renderSection();
      await waitFor(() =>
        expect(screen.getByText('github.token')).toBeInTheDocument(),
      );

      const rendered = document.body.textContent ?? '';

      for (const forbidden of [
        PLAINTEXT_TOKEN,
        PLAINTEXT_KEY,
        // The four characters the API deliberately reveals. Useful where an
        // operator is matching a value they hold; four characters of a
        // credential here.
        'Ly5Hs',
        '9Rk1',
        // Not even the mask: printing it says "there is a value here" in a
        // shape that invites reading the characters beside it.
        '********',
      ]) {
        expect(rendered, `rendered DOM contains ${forbidden}`).not.toContain(
          forbidden,
        );
      }

      // And the row is still there, saying what it can: three secret changes,
      // plus the one non-secret field the user row also carried.
      expect(screen.getAllByText('Secret set')).toHaveLength(2);
      expect(screen.getByText('Secret changed')).toBeInTheDocument();
      expect(screen.getByText('Ada')).toBeInTheDocument();
    });
  });

  describe('the target-type filter', () => {
    it('asks the SERVER for one target type', async () => {
      const requested: string[] = [];
      server.events.on('request:start', ({ request }) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith('/audit-events')) {
          requested.push(url.searchParams.get('targetType') ?? '');
        }
      });

      const user = userEvent.setup();
      renderSection(DESKTOP_WIDTH);
      await waitFor(
        () => expect(requested.length).toBeGreaterThan(0),
        // The first read is unfiltered.
      );
      expect(requested[0]).toBe('');

      await user.click(screen.getByRole('combobox', { name: 'Value' }));
      const listbox = await screen.findByRole('listbox');
      await user.click(within(listbox).getByRole('option', { name: 'Users' }));
      await user.click(screen.getByTestId('datatable-filter-apply'));

      // Filtering happens server-side: the endpoint's own `targetType`, not a
      // pass over the 25 rows that happen to be loaded.
      await waitFor(() => expect(requested).toContain('user'));

      server.events.removeAllListeners();
    });

    it('offers only target types the audit log actually has writers for', async () => {
      const user = userEvent.setup();
      renderSection(DESKTOP_WIDTH);
      await awaitRows();

      await user.click(screen.getByRole('combobox', { name: 'Value' }));
      const options = within(await screen.findByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent);

      expect(options[0]).toBe('Operator settings');
      expect(options).toContain('Allowlist');
      expect(options).toContain('Work orders');
    });
  });

  describe('when there is nothing to show', () => {
    it('says the log is empty rather than showing a spinner forever', async () => {
      server.use(
        http.get(`${API}/audit-events`, () =>
          HttpResponse.json({
            data: { items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 },
          }),
        ),
      );

      renderSection();

      expect(
        await screen.findByText(/Nothing has been recorded yet/i),
      ).toBeInTheDocument();
    });

    it('surfaces a failed read instead of an empty table', async () => {
      server.use(
        http.get(`${API}/audit-events`, () =>
          HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
        ),
      );

      renderSection();

      expect(await screen.findByText(/Forbidden/i)).toBeInTheDocument();
    });
  });

  it('reports when the rows were read, never when the page was drawn', async () => {
    renderSection();
    await awaitRows();

    // The same rule the Readiness section follows: a screen that says "now"
    // while showing a five-minute-old table is the lie this screen is against.
    await waitFor(() =>
      expect(screen.getByText(/^Read at /)).toBeInTheDocument(),
    );
  });
});

/** One audit row in the API's serialization. Overridable field by field. */
function auditRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    action: 'operator_settings:set',
    targetType: 'operator_settings',
    targetId: 'github.token',
    actorUserId: 'admin-user-id',
    actor: {
      id: 'admin-user-id',
      email: 'admin@example.com',
      displayName: 'Admin User',
    },
    meta: {},
    createdAt: '2026-08-26T10:00:00.000Z',
    ...overrides,
  };
}
