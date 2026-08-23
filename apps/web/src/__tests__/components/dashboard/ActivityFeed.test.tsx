import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { ActivityFeed } from '../../../components/dashboard/ActivityFeed';
import type { RunEvent } from '../../../types/cockpit';
import type { UseActivityFeedResult } from '../../../hooks/useActivityFeed';

vi.mock('../../../hooks/useActivityFeed', () => ({
  useActivityFeed: vi.fn(),
}));

import { useActivityFeed } from '../../../hooks/useActivityFeed';

const mockHook = vi.mocked(useActivityFeed);

function hookResult(
  overrides: Partial<UseActivityFeedResult> = {},
): UseActivityFeedResult {
  return {
    data: null,
    state: 'unwired',
    error: null,
    lastUpdatedAt: null,
    isRefreshing: false,
    refresh: vi.fn(),
    phase: 'Phase 2 — Reconciler, read-only',
    ...overrides,
  };
}

const event: RunEvent = {
  id: 'event-1',
  type: 'run.blocked',
  source: 'runner',
  occurredAt: new Date().toISOString(),
  runId: 'run-1',
  workOrderId: 'wo_opifex_312_a3f91c2_a1',
  summary: 'Rate limited; resets at 14:00.',
};

describe('ActivityFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHook.mockReturnValue(hookResult());
  });

  /**
   * Events arrive in Phase 2 — the read-only reconciler — long before anything
   * is dispatched, so this is the first cockpit panel that can ever be wired
   * and its unwired caption names an EARLIER phase than the panels above it.
   */
  it('names Phase 2, the earliest of the four panels', () => {
    render(<ActivityFeed />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Activity' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Arrives in Phase 2 — Reconciler, read-only/),
    ).toBeInTheDocument();
  });

  it('reports an empty window neutrally', () => {
    mockHook.mockReturnValue(hookResult({ data: [], state: 'empty' }));

    render(<ActivityFeed />);

    expect(screen.getByText('No events yet.')).toBeInTheDocument();
  });

  describe('ready', () => {
    it('renders the event type as a phrase and the work order in mono', () => {
      mockHook.mockReturnValue(hookResult({ data: [event], state: 'ready' }));

      render(<ActivityFeed />);

      expect(screen.getByText('Blocked')).toBeInTheDocument();
      // The wire form is a protocol identifier; six of them stacked in a
      // column read as noise.
      expect(screen.queryByText('run.blocked')).not.toBeInTheDocument();
      expect(screen.getByText('wo_opifex_312_a3f91c2_a1')).toHaveClass(
        'opifex-mono',
      );
      expect(
        screen.getByText('Rate limited; resets at 14:00.'),
      ).toBeInTheDocument();
    });

    /**
     * VISION §9: "a synthesized event must never masquerade as a report." Two
     * independent liveness sources are only worth having if the operator can
     * tell which one spoke.
     */
    it('labels every event with the source that reported it', () => {
      mockHook.mockReturnValue(
        hookResult({
          data: [
            event,
            { ...event, id: 'event-2', source: 'git' },
            { ...event, id: 'event-3', source: 'control-plane' },
          ],
          state: 'ready',
        }),
      );

      render(<ActivityFeed />);

      expect(screen.getByText('runner-reported')).toBeInTheDocument();
      expect(screen.getByText('git-derived')).toBeInTheDocument();
      expect(screen.getByText('control-plane-synthesized')).toBeInTheDocument();
    });

    it('does not render an event type as a run status chip', () => {
      // Events are what a runner REPORTS; a status is what the control plane
      // CONCLUDED. Collapsing the two vocabularies is the bug `types/cockpit.ts`
      // documents at length.
      mockHook.mockReturnValue(hookResult({ data: [event], state: 'ready' }));

      render(<ActivityFeed />);

      expect(
        screen.queryByText('Blocked', { selector: '.MuiChip-label' }),
      ).not.toBeInTheDocument();
    });
  });
});
