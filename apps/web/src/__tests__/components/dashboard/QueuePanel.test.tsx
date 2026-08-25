import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { QueuePanel } from '../../../components/dashboard/QueuePanel';
import type { QueueEntry } from '../../../types/cockpit';
import type { UseRunQueueResult } from '../../../hooks/useRunQueue';

vi.mock('../../../hooks/useRunQueue', () => ({
  useRunQueue: vi.fn(),
}));

import { useRunQueue } from '../../../hooks/useRunQueue';

const mockHook = vi.mocked(useRunQueue);

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

/**
 * `waitingOn` strings the API can ACTUALLY produce, copied from
 * `apps/api/src/cockpit/queue.service.ts` and the dispatch policy it reuses.
 *
 * This fixture used to read `'quota reset at 14:00'` — a hand-written noun
 * phrase no code path emits — which is precisely why #170 (the "Waiting on
 * All 1 registered runner(s) are disabled." collision) was invisible to the
 * suite while being the first thing visible on the screen. A fixture the
 * server cannot generate tests the component against a fiction.
 */
const REAL_WAITING_ON = {
  /** `decideDispatch`, whole fleet disabled — the string quoted in #170. */
  runnersDisabled: 'All 1 registered runner(s) are disabled.',
  /** `QueueService.waitingOn`, rows ahead took the free slots. */
  outOfHeadroom:
    'Waiting for a free slot on claude-code-local; the work orders ahead of it take them all',
  /** `explain()` wrapping the #253 self-reported unavailability verdict. */
  runnerUnavailable:
    'Queued: no runner can take this work order (needs no specific capabilities). ' +
    'claude-code-local reports it cannot take work right now: the CLI binary is missing.',
  /** `QueueService.waitingOn`, held with no recorded reason. */
  held: 'Held by a factory:hold label; release it on the issue',
} as const;

const entry: QueueEntry = {
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
};

describe('QueuePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHook.mockReturnValue(hookResult());
  });

  it('titles itself and links to the full queue', () => {
    render(<QueuePanel />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Queue' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Full queue' })).toHaveAttribute(
      'href',
      '/queue',
    );
  });

  it('names Phase 4 as the phase that fills it', () => {
    render(<QueuePanel />);

    expect(
      screen.getByText(/The queue appears here once dispatch exists/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Arrives in Phase 4 — Execution/),
    ).toBeInTheDocument();
  });

  /**
   * Neutral, not congratulatory. An empty attention panel is good news; an
   * empty queue is an idle factory, and a green check mark next to "nothing
   * scheduled" would be the UI cheering for the absence of work.
   */
  it('reports an empty queue neutrally', () => {
    mockHook.mockReturnValue(hookResult({ data: [], state: 'empty' }));

    render(<QueuePanel />);

    expect(screen.getByText('The queue is empty.')).toBeInTheDocument();
    expect(screen.queryByText(/Arrives in/)).not.toBeInTheDocument();
  });

  describe('ready', () => {
    it('renders position, title, id and what the entry is waiting on', () => {
      mockHook.mockReturnValue(hookResult({ data: [entry], state: 'ready' }));

      render(<QueuePanel />);

      expect(screen.getByText('1.')).toHaveClass('opifex-num');
      expect(
        screen.getByText('Wire the metrics summary endpoint'),
      ).toBeInTheDocument();
      expect(screen.getByText('wo_opifex_401_b7c2d10_a1')).toHaveClass(
        'opifex-mono',
      );
      expect(
        screen.getByText(REAL_WAITING_ON.runnersDisabled),
      ).toBeInTheDocument();
    });

    /**
     * #170. The API sends a complete sentence, so the panel must not prefix
     * it. Every one of these reads as a grammatical line ONLY unprefixed —
     * "Waiting on Waiting for a free slot on claude-code-local…" is the bug.
     */
    it.each(Object.entries(REAL_WAITING_ON))(
      'renders the %s sentence verbatim, with nothing prefixed to it',
      (_name, sentence) => {
        mockHook.mockReturnValue(
          hookResult({
            data: [{ ...entry, waitingOn: sentence }],
            state: 'ready',
          }),
        );

        render(<QueuePanel />);

        const line = screen.getByText(sentence);
        expect(line).toBeInTheDocument();
        // The whole element is the sentence — no leading label ran into it.
        expect(line.textContent).toBe(sentence);
        expect(screen.queryByText(/Waiting on /)).not.toBeInTheDocument();
      },
    );

    /**
     * `held` is a POLICY outcome and `waiting` is a scheduling one: waiting
     * clears itself, held waits on a human. The labels have to preserve that
     * or the distinction dies at the last step.
     */
    it('distinguishes a held entry from one merely waiting', () => {
      mockHook.mockReturnValue(
        hookResult({
          data: [
            entry,
            {
              ...entry,
              id: 'queue-2',
              state: 'held',
              position: 2,
              waitingOn: REAL_WAITING_ON.held,
            },
          ],
          state: 'ready',
        }),
      );

      render(<QueuePanel />);

      expect(screen.getByText('Waiting')).toBeInTheDocument();
      expect(screen.getByText('On hold')).toBeInTheDocument();
    });

    /**
     * #170. A `factory:hold` label is not an approval gate — approvals are a
     * separate mechanism with their own record and their own screen — and the
     * chip claiming one sends the operator to `/approvals` for a decision that
     * was never requested.
     */
    it('does not call a hold an approval', () => {
      mockHook.mockReturnValue(
        hookResult({
          data: [
            {
              ...entry,
              state: 'held',
              waitingOn: REAL_WAITING_ON.held,
            },
          ],
          state: 'ready',
        }),
      );

      render(<QueuePanel />);

      expect(screen.queryByText(/approval/i)).not.toBeInTheDocument();
      expect(screen.getByText(REAL_WAITING_ON.held)).toBeInTheDocument();
    });
  });
});
