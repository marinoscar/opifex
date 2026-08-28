/**
 * Bulk hold and mark-ready on the queue screen (#421).
 *
 * The queue itself is mocked at the hook, exactly as `QueuePage.test.tsx` does,
 * because what is under test is the SELECTION and the report — not polling.
 * The two steer endpoints are served by MSW rather than stubbed on the module,
 * so these tests see the requests the browser would really issue, one per work
 * order, and can assert that steering writes nothing else anywhere.
 *
 * Every fixture response is built by `mocks/queueSteering.ts`, which is
 * type-checked against `QueueSteerResult` (#417) — a fixture inventing a field
 * the API does not serve is how a suite stays green while the screen is wrong.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render, mockAdminUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import { steerResultFixture } from '../mocks/queueSteering';
import QueuePage from '../../pages/QueuePage';
import type { QueueEntry } from '../../types/cockpit';
import type { UseRunQueueResult } from '../../hooks/useRunQueue';

vi.mock('../../hooks/useRunQueue', () => ({
  useRunQueue: vi.fn(),
}));

import { useRunQueue } from '../../hooks/useRunQueue';

const mockHook = vi.mocked(useRunQueue);

/** The seeded `admin` role really holds `workorders:write` (`prisma/seed.ts`). */
const steerer = mockAdminUser;

function hookResult(entries: QueueEntry[]): UseRunQueueResult {
  return {
    data: entries,
    state: 'ready',
    error: null,
    lastUpdatedAt: null,
    isRefreshing: false,
    refresh: vi.fn(),
    phase: 'Phase 4 — Execution',
  };
}

function entry(identity: string, position: number): QueueEntry {
  return {
    id: `queue-${position}`,
    workOrder: {
      id: identity,
      issueNumber: 400 + position,
      repository: 'opifex/opifex',
      baseCommit: 'b7c2d10',
      attempt: 1,
      branch: `factory/${400 + position}-b7c2d10-a1`,
      title: 'Wire the metrics summary endpoint',
      issueUrl: null,
    },
    state: 'waiting',
    position,
    enqueuedAt: new Date().toISOString(),
    waitingOn: 'All 1 registered runner(s) are disabled.',
  };
}

const IDENTITIES = [
  'wo_opifex_401_b7c2d10_a1',
  'wo_opifex_402_b7c2d10_a1',
  'wo_opifex_403_b7c2d10_a1',
];

const ENTRIES = IDENTITIES.map((identity, index) => entry(identity, index + 1));

/**
 * Every mutating request the app makes during a test.
 *
 * Recorded rather than asserted per handler so that a write to some OTHER
 * endpoint — a new "what to work on" record of the kind #421 exists to avoid —
 * would show up here and fail the test, instead of passing silently because
 * nothing was looking at it.
 */
function recordWrites(): string[] {
  const written: string[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method !== 'GET')
      written.push(`${request.method} ${request.url}`);
  });
  return written;
}

/** Serve the steer endpoints, answering each work order in turn. */
function serveSteering(
  intent: 'hold' | 'release',
  answer: (identity: string) => Response,
) {
  server.use(
    http.post(`*/api/queue/:workOrderId/${intent}`, ({ params }) => {
      return answer(String(params.workOrderId));
    }),
  );
}

function ok(identity: string, overrides = {}) {
  return HttpResponse.json({
    data: steerResultFixture({ identity, ...overrides }),
  });
}

function renderQueue(entries: QueueEntry[] = ENTRIES) {
  mockHook.mockReturnValue(hookResult(entries));
  return render(<QueuePage />, { wrapperOptions: { user: steerer } });
}

function checkboxFor(identity: string) {
  return screen.getByRole('checkbox', { name: `Select ${identity}` });
}

const markReady = () =>
  screen.getByRole('button', {
    name: 'Mark the selected work orders ready',
  });
const holdAll = () =>
  screen.getByRole('button', { name: 'Hold the selected work orders' });

describe('QueuePage — bulk steering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    server.events.removeAllListeners();
  });

  it('steers nothing until something is selected', async () => {
    renderQueue();

    expect(markReady()).toBeDisabled();
    expect(holdAll()).toBeDisabled();
    expect(
      screen.getByText(/Nothing selected\./, { exact: false }),
    ).toBeInTheDocument();
  });

  it('writes one label per selected work order and reports each', async () => {
    const user = userEvent.setup();
    const writes = recordWrites();
    serveSteering('release', (identity) => ok(identity));
    renderQueue();

    await user.click(checkboxFor(IDENTITIES[0]));
    await user.click(checkboxFor(IDENTITIES[1]));
    await user.click(markReady());

    await screen.findByText(/3 work orders|2 work orders/);

    // One request per work order, both to the steering endpoint, and NOTHING
    // else was written: the intent lands as a GitHub label, not as a new
    // persisted expression of what to work on.
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes).toEqual([
      `POST http://localhost:3000/api/queue/${IDENTITIES[0]}/release`,
      `POST http://localhost:3000/api/queue/${IDENTITIES[1]}/release`,
    ]);

    const report = screen.getByRole('alert');
    expect(within(report).getByText(/2 work orders/)).toBeInTheDocument();
    expect(within(report).getAllByText(/factory:ready/).length).toBeGreaterThan(
      1,
    );
    // Both work orders are named individually; a headline alone is a summary.
    expect(within(report).getAllByText(IDENTITIES[0])).not.toHaveLength(0);
  });

  it('drops what landed out of the selection', async () => {
    const user = userEvent.setup();
    serveSteering('hold', (identity) =>
      ok(identity, { label: 'factory:hold' }),
    );
    renderQueue();

    await user.click(checkboxFor(IDENTITIES[0]));
    await user.click(holdAll());

    await screen.findByRole('alert');
    // The row is now waiting for a tick, so its checkbox is gone from the
    // steerable set entirely — re-sending would spend a GitHub write to change
    // nothing.
    await waitFor(() => expect(checkboxFor(IDENTITIES[0])).toBeDisabled());
    expect(checkboxFor(IDENTITIES[0])).not.toBeChecked();
  });

  it('keeps the failures selected and never calls a partial run complete', async () => {
    const user = userEvent.setup();
    serveSteering('release', (identity) =>
      identity === IDENTITIES[1]
        ? HttpResponse.json(
            { message: 'Work order not found', statusCode: 404 },
            { status: 404 },
          )
        : ok(identity),
    );
    renderQueue();

    await user.click(screen.getByRole('checkbox', { name: /on this page/ }));
    await user.click(markReady());

    const report = await screen.findByRole('alert');

    // A fraction, out of what was attempted. "2 written" alone would read as
    // the whole answer.
    expect(within(report).getByText(/2 of 3 written/)).toBeInTheDocument();
    expect(within(report).getByText(/1 refused/)).toBeInTheDocument();
    expect(
      within(report).getByText(/Work order not found/, { exact: false }),
    ).toBeInTheDocument();

    // The one that failed is still ticked; a retry re-sends only it.
    await waitFor(() => expect(checkboxFor(IDENTITIES[1])).toBeChecked());
    expect(
      screen.getByText('1 of the 1 on this page selected.'),
    ).toBeInTheDocument();
  });

  it('says the intent was recorded and nothing written when writes are disabled', async () => {
    const user = userEvent.setup();
    serveSteering('release', (identity) =>
      ok(identity, { labelWritten: false }),
    );
    renderQueue();

    await user.click(screen.getByRole('checkbox', { name: /on this page/ }));
    await user.click(markReady());

    const report = await screen.findByRole('alert');

    // THE assertion this feature turns on. Three requests answered 200 and
    // three labels do not exist on GitHub.
    expect(report).toHaveClass('MuiAlert-colorWarning');
    expect(
      within(report).getByText(/Nothing was written for any of the 3/),
    ).toBeInTheDocument();
    expect(within(report).queryByText(/written to each/)).toBeNull();
    // Said in the headline body AND on each work order's own line: an
    // operator scanning the per-row list must not have to infer it from the
    // banner above.
    expect(
      within(report).getAllByText(/writes are disabled/).length,
    ).toBeGreaterThan(1);

    // Nothing goes pending, because nothing is waiting for a tick — and all
    // three stay selected, ready to be re-sent once writes are back on.
    expect(screen.queryByText(/requested — next tick/)).toBeNull();
    await waitFor(() => expect(checkboxFor(IDENTITIES[0])).toBeChecked());
    expect(checkboxFor(IDENTITIES[2])).toBeChecked();
    expect(
      screen.getByText('3 of the 3 on this page selected.'),
    ).toBeInTheDocument();
  });

  it('bounds select-all to the rows on this page', async () => {
    const user = userEvent.setup();
    const writes = recordWrites();
    serveSteering('hold', (identity) =>
      ok(identity, { label: 'factory:hold' }),
    );
    // Two rows on screen. The queue behind them is irrelevant: the page is the
    // bound, and selecting an unseen five hundred is what this prevents.
    renderQueue(ENTRIES.slice(0, 2));

    await user.click(screen.getByRole('checkbox', { name: /on this page/ }));

    expect(
      screen.getByText('2 of the 2 on this page selected.'),
    ).toBeInTheDocument();

    await user.click(holdAll());
    await screen.findByRole('alert');

    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes.every((write) => write.endsWith('/hold'))).toBe(true);
  });

  it('says a release goes to the back of the queue and clears no quarantine', () => {
    renderQueue();

    expect(
      screen.getByText(/BACK of the queue/, { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/factory:clear-quarantine/, { exact: false }),
    ).toBeInTheDocument();
  });

  it('offers no selection at all to an account that cannot steer', () => {
    mockHook.mockReturnValue(hookResult(ENTRIES));
    render(<QueuePage />);

    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: 'Mark the selected work orders ready',
      }),
    ).toBeNull();
  });
});
