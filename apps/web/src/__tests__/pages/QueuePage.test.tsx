/**
 * `/queue` — and specifically, that the `waitingOn` column reads as English.
 *
 * #170 was filed against the dashboard panel, but the page had the identical
 * collision one level up: a `Waiting on` column HEADER sitting above the same
 * complete sentences. The panel's fix is worthless if the full-queue screen an
 * operator clicks through to still reads "Waiting on / Waiting for a free slot
 * on claude-code-local…", so the wording is pinned here too.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils/test-utils';
import QueuePage from '../../pages/QueuePage';
import type { QueueEntry } from '../../types/cockpit';
import type { UseRunQueueResult } from '../../hooks/useRunQueue';

vi.mock('../../hooks/useRunQueue', () => ({
  useRunQueue: vi.fn(),
}));

import { useRunQueue } from '../../hooks/useRunQueue';

const mockHook = vi.mocked(useRunQueue);

/**
 * The same real strings the panel test uses, taken from
 * `apps/api/src/cockpit/queue.service.ts` and the dispatch policy it reuses.
 * Nothing invented: a fixture the server cannot produce is what let #170 pass
 * the suite and fail on the screen.
 */
const REAL_WAITING_ON = {
  runnersDisabled: 'All 1 registered runner(s) are disabled.',
  outOfHeadroom:
    'Waiting for a free slot on claude-code-local; the work orders ahead of it take them all',
  runnerUnavailable:
    'Queued: no runner can take this work order (needs no specific capabilities). ' +
    'claude-code-local reports it cannot take work right now: the CLI binary is missing.',
  held: 'Held by a factory:hold label; release it on the issue',
} as const;

function hookResult(
  overrides: Partial<UseRunQueueResult> = {},
): UseRunQueueResult {
  return {
    data: null,
    state: 'unwired',
    error: null,
    lastUpdatedAt: null,
    isRefreshing: false,
    refresh: vi.fn(),
    phase: 'Phase 4 — Execution',
    ...overrides,
  };
}

function entry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: 'queue-1',
    workOrder: {
      id: 'wo_opifex_401_b7c2d10_a1',
      issueNumber: 401,
      repository: 'opifex/opifex',
      baseCommit: 'b7c2d10',
      attempt: 1,
      branch: 'factory/401-b7c2d10-a1',
      title: 'Wire the metrics summary endpoint',
      issueUrl: null,
    },
    state: 'waiting',
    position: 1,
    enqueuedAt: new Date().toISOString(),
    waitingOn: REAL_WAITING_ON.runnersDisabled,
    ...overrides,
  };
}

describe('QueuePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHook.mockReturnValue(hookResult({ data: [], state: 'empty' }));
  });

  it('heads the reason column with a question rather than half a sentence', () => {
    mockHook.mockReturnValue(hookResult({ data: [entry()], state: 'ready' }));

    render(<QueuePage />);

    expect(
      screen.getByRole('columnheader', { name: 'Why it is waiting' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: 'Waiting on' }),
    ).not.toBeInTheDocument();
  });

  it.each(Object.entries(REAL_WAITING_ON))(
    'renders the %s sentence verbatim in its cell',
    (_name, sentence) => {
      mockHook.mockReturnValue(
        hookResult({ data: [entry({ waitingOn: sentence })], state: 'ready' }),
      );

      render(<QueuePage />);

      const cell = screen.getByText(sentence);
      expect(cell).toBeInTheDocument();
      expect(cell.textContent).toBe(sentence);
    },
  );

  /**
   * A hold is a `factory:hold` label, released by writing `factory:ready`
   * back. Approvals are a separate mechanism with their own record and their
   * own screen, and this page must not borrow their vocabulary (#170).
   */
  it('does not describe a held work order as awaiting approval', () => {
    mockHook.mockReturnValue(
      hookResult({
        data: [entry({ state: 'held', waitingOn: REAL_WAITING_ON.held })],
        state: 'ready',
      }),
    );

    render(<QueuePage />);

    expect(screen.getByText('held')).toBeInTheDocument();
    expect(screen.queryByText(/approval/i)).not.toBeInTheDocument();
  });

  it('shows an em dash when nothing is blocking the entry', () => {
    mockHook.mockReturnValue(
      hookResult({
        data: [entry({ state: 'ready', waitingOn: null })],
        state: 'ready',
      }),
    );

    render(<QueuePage />);

    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
