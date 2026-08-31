import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import {
  installLayoutStubs,
  setInitialContainerWidth,
} from '../../components/datatable/__tests__/testUtils/layoutStubs';
import QuotaPage from '../../pages/QuotaPage';
import type {
  ExhaustedWindow,
  QuotaSummary,
  RateLimitEpisode,
} from '../../types/quota';

/**
 * `/quota` — the live gauge and the rate-limit history beneath it (#476).
 *
 * Rendered through MSW and the REAL hooks, following `ApprovalsPage.test.tsx`
 * and `TrustPage.test.tsx`: a mocked hook could not prove which query
 * parameter a filter or a range actually sends, only that the page BELIEVES
 * it sends one.
 *
 * The row fixtures below are the ones the implementing agent's smoke-test
 * fixture set already established — two reasons, an `unknown` disposition, a
 * `blockedRuns: 0` window and a still-open episode — reused rather than
 * reinvented, so this suite and that one agree about what the API can
 * actually send.
 *
 * A wide container throughout: both history tables resolve to the DESKTOP
 * grid renderer, whose filter row is inline rather than behind a "Filters"
 * toggle — the #253 recipe every DataTable suite in this app uses.
 */

const API = '*/api';
const TABLE_WIDTH = 1400;

const summaryFixture: QuotaSummary = {
  generatedAt: '2026-08-31T00:00:00.000Z',
  runners: [
    {
      runnerKey: 'claude-code-local',
      position: {
        exhausted: true,
        resumesAt: '2026-08-31T04:00:00.000Z',
        basis: 'the five_hour window read exhausted at 2026-08-30T23:00:00Z',
      },
      windows: [
        {
          windowKind: 'five_hour',
          resetsAt: '2026-08-31T04:00:00.000Z',
          startedAt: '2026-08-30T23:00:00.000Z',
          startedAtBasis: 'vendor-window-length',
          partialWindow: true,
          pressure: 'exhausted',
          peakPressure: 'exhausted',
          lastObservedAt: '2026-08-30T23:50:00.000Z',
          observations: 4,
          opifexConsumption: {
            runs: 3,
            runsWithoutCost: 1,
            reportedUsd: 1.23,
            tokensInput: null,
            tokensOutput: null,
          },
          burnFraction: null,
          basis: 'Opifex ran 3 runs through this window; 1 reported no cost.',
        },
      ],
    },
  ],
};

/** `disposition: 'unknown'`, still open (`durationMs: null`). */
const UNKNOWN_EPISODE: RateLimitEpisode = {
  eventId: '11111111-1111-4111-8111-111111111111',
  occurredAt: '2026-08-30T23:05:00.000Z',
  blockedUntil: '2026-08-31T04:00:00.000Z',
  reason: 'quota-exhausted',
  runId: '22222222-2222-4222-8222-222222222222',
  runStatus: 'running',
  runnerKey: 'claude-code-local',
  workOrderIdentity: 'wo_opifex_476_a3f91c2_a1',
  repository: 'marinoscar/opifex',
  issueNumber: 476,
  disposition: 'unknown',
  dispositionBasis:
    "nothing stored says: the run is 'running', no resume is scheduled",
  resumesAt: null,
  nextActivityAt: null,
  durationMs: null,
  escalation: null,
  window: null,
};

/** The other reason (`rate-limit`), resolved (`disposition: 'resumed'`). */
const OVERAGE_EPISODE: RateLimitEpisode = {
  eventId: '33333333-3333-4333-8333-333333333333',
  occurredAt: '2026-08-30T20:05:00.000Z',
  blockedUntil: null,
  reason: 'rate-limit',
  runId: '44444444-4444-4444-8444-444444444444',
  runStatus: 'succeeded',
  runnerKey: 'claude-code-local',
  workOrderIdentity: 'wo_opifex_475_b3f91c2_a1',
  repository: 'marinoscar/opifex',
  issueNumber: 475,
  disposition: 'resumed',
  dispositionBasis: 'the run reported again at 2026-08-30T20:20:00Z',
  resumesAt: null,
  nextActivityAt: '2026-08-30T20:20:00.000Z',
  durationMs: 900000,
  escalation: null,
  window: null,
};

/** The case the windows endpoint exists for: the ceiling hit, nothing dispatched. */
const ZERO_BLOCKED_WINDOW: ExhaustedWindow = {
  runnerKey: 'claude-code-local',
  kind: 'five_hour',
  resetsAt: '2026-08-31T04:00:00.000Z',
  pressure: 'allowed',
  peakPressure: 'exhausted',
  firstObservedAt: '2026-08-30T22:00:00.000Z',
  lastObservedAt: '2026-08-30T23:50:00.000Z',
  observations: 4,
  blockedRuns: 0,
  blockedEvents: 0,
};

/** Every query string `GET /quota/events` and `GET /quota/windows` were called with. */
let episodeQueries: string[] = [];
let windowQueries: string[] = [];

function serveSummary(summary: QuotaSummary) {
  server.use(
    http.get(`${API}/quota`, () => HttpResponse.json({ data: summary })),
  );
}

function serveEpisodes(pick: (url: URL) => RateLimitEpisode[]) {
  server.use(
    http.get(`${API}/quota/events`, ({ request }) => {
      const url = new URL(request.url);
      episodeQueries.push(url.search);
      const items = pick(url);
      return HttpResponse.json({
        data: {
          items,
          total: items.length,
          page: 1,
          pageSize: 25,
          totalPages: 1,
        },
      });
    }),
  );
}

function serveWindows(pick: (url: URL) => ExhaustedWindow[]) {
  server.use(
    http.get(`${API}/quota/windows`, ({ request }) => {
      const url = new URL(request.url);
      windowQueries.push(url.search);
      const items = pick(url);
      return HttpResponse.json({
        data: {
          items,
          total: items.length,
          page: 1,
          pageSize: 25,
          totalPages: 1,
        },
      });
    }),
  );
}

/** The episodes `DataTable`, scoped: it is rendered first, the windows table second. */
function episodesTable() {
  return within(screen.getAllByTestId('datatable')[0]);
}

/** The windows `DataTable`, the second of the two on the page. */
function windowsTable() {
  return within(screen.getAllByTestId('datatable')[1]);
}

describe('QuotaPage', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    setInitialContainerWidth(TABLE_WIDTH);
    episodeQueries = [];
    windowQueries = [];
    serveSummary(summaryFixture);
    serveEpisodes(() => [UNKNOWN_EPISODE, OVERAGE_EPISODE]);
    serveWindows(() => [ZERO_BLOCKED_WINDOW]);
  });

  it('renders the gauge above the history, and both reasons in it', async () => {
    render(<QuotaPage />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Quota' }),
    ).toBeInTheDocument();
    await screen.findByTestId('quota-gauge');
    expect(
      await episodesTable().findByText(OVERAGE_EPISODE.workOrderIdentity),
    ).toBeInTheDocument();
    expect(
      episodesTable().getByText(UNKNOWN_EPISODE.workOrderIdentity),
    ).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // dispositionBasis reaching the operator is the whole point of #476
  // -------------------------------------------------------------------------

  it('renders dispositionBasis verbatim in the Why column', async () => {
    render(<QuotaPage />);

    expect(
      await episodesTable().findByText(UNKNOWN_EPISODE.dispositionBasis),
    ).toBeInTheDocument();
    expect(
      episodesTable().getByText(OVERAGE_EPISODE.dispositionBasis),
    ).toBeInTheDocument();
  });

  it('renders an unknown disposition as "Not recorded", never blank', async () => {
    render(<QuotaPage />);

    const label = await episodesTable().findByText('Not recorded');
    const chip = label.closest('[data-disposition]');
    // The wire value, not just the label — proof the row really carries
    // `disposition: 'unknown'` rather than an empty cell that happens to read
    // the same in English.
    expect(chip).toHaveAttribute('data-disposition', 'unknown');
  });

  // -------------------------------------------------------------------------
  // Empty states, for both tables independently
  // -------------------------------------------------------------------------

  it('states the episodes empty case in words, not a bare empty table', async () => {
    serveEpisodes(() => []);
    render(<QuotaPage />);

    expect(
      await episodesTable().findByText(/no run was blocked by a rate limit/i),
    ).toBeInTheDocument();
  });

  it('states the windows empty case in words, not a bare empty table', async () => {
    serveWindows(() => []);
    render(<QuotaPage />);

    expect(
      await windowsTable().findByText(/no window reached its ceiling/i),
    ).toBeInTheDocument();
  });

  it('describes a blockedRuns: 0 window as "Nothing dispatched"', async () => {
    render(<QuotaPage />);

    expect(
      await windowsTable().findByText('Nothing dispatched'),
    ).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // The range: shared by both tables, and it really changes `since`
  // -------------------------------------------------------------------------

  it('refetches both tables with a new `since` when the range changes', async () => {
    const user = userEvent.setup();
    render(<QuotaPage />);

    await episodesTable().findByText(UNKNOWN_EPISODE.workOrderIdentity);
    await waitFor(() => {
      expect(episodeQueries.at(-1)).toContain('since=');
      expect(windowQueries.at(-1)).toContain('since=');
    });

    await user.click(screen.getByRole('combobox', { name: 'Range' }));
    await user.click(
      within(await screen.findByRole('listbox')).getByRole('option', {
        name: 'All time',
      }),
    );

    // "All time" has no lower bound at all (`sinceFor` returns undefined), so
    // the NEXT request must drop `since` entirely rather than send an empty
    // or a stale value.
    await waitFor(() => {
      expect(episodeQueries.at(-1)).not.toContain('since=');
      expect(windowQueries.at(-1)).not.toContain('since=');
    });
  });

  // -------------------------------------------------------------------------
  // The reason filter: maps to the one parameter `/quota/events` accepts
  // -------------------------------------------------------------------------

  it('maps the reason filter to the `reason` query parameter, and never sends it to /quota/windows', async () => {
    const user = userEvent.setup();
    render(<QuotaPage />);

    const table = episodesTable();
    await table.findByText(UNKNOWN_EPISODE.workOrderIdentity);

    // `reason` is the first filterable column, so it is already the filter
    // editor's default draft — only the value has to be chosen.
    await user.click(table.getByRole('combobox', { name: 'Value' }));
    await user.click(
      within(await screen.findByRole('listbox')).getByRole('option', {
        name: 'Window spent',
      }),
    );
    await user.click(table.getByTestId('datatable-filter-apply'));

    await waitFor(() =>
      expect(episodeQueries.at(-1)).toContain('reason=quota-exhausted'),
    );
    // The windows endpoint has no `reason` parameter at all — a window has
    // none — so the shared filter state must never leak it across.
    expect(windowQueries.some((query) => query.includes('reason'))).toBe(false);
  });
});
