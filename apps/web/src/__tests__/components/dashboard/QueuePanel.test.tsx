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

function hookResult(overrides: Partial<UseRunQueueResult> = {}): UseRunQueueResult {
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
  waitingOn: 'quota reset at 14:00',
};

describe('QueuePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHook.mockReturnValue(hookResult());
  });

  it('titles itself and links to the full queue', () => {
    render(<QueuePanel />);

    expect(screen.getByRole('heading', { level: 2, name: 'Queue' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Full queue' })).toHaveAttribute('href', '/queue');
  });

  it('names Phase 4 as the phase that fills it', () => {
    render(<QueuePanel />);

    expect(screen.getByText(/The queue appears here once dispatch exists/)).toBeInTheDocument();
    expect(screen.getByText(/Arrives in Phase 4 — Execution/)).toBeInTheDocument();
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
      expect(screen.getByText('Wire the metrics summary endpoint')).toBeInTheDocument();
      expect(screen.getByText('wo_opifex_401_b7c2d10_a1')).toHaveClass('opifex-mono');
      expect(screen.getByText('Waiting on quota reset at 14:00')).toBeInTheDocument();
    });

    /**
     * `held` is a POLICY outcome and `waiting` is a scheduling one: waiting
     * clears itself, held waits on a human. The labels have to preserve that
     * or the distinction dies at the last step.
     */
    it('distinguishes an entry held for approval from one merely waiting', () => {
      mockHook.mockReturnValue(
        hookResult({
          data: [entry, { ...entry, id: 'queue-2', state: 'held', position: 2 }],
          state: 'ready',
        }),
      );

      render(<QueuePanel />);

      expect(screen.getByText('Waiting')).toBeInTheDocument();
      expect(screen.getByText('Held for approval')).toBeInTheDocument();
    });
  });
});
