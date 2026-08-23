import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { AttentionPanel } from '../../../components/dashboard/AttentionPanel';
import type { RunSummary } from '../../../types/cockpit';
import type { UseRunsNeedingAttentionResult } from '../../../hooks/useRunsNeedingAttention';

vi.mock('../../../hooks/useRunsNeedingAttention', () => ({
  useRunsNeedingAttention: vi.fn(),
}));

import { useRunsNeedingAttention } from '../../../hooks/useRunsNeedingAttention';

const mockHook = vi.mocked(useRunsNeedingAttention);

function hookResult(
  overrides: Partial<UseRunsNeedingAttentionResult> = {},
): UseRunsNeedingAttentionResult {
  return {
    data: null,
    state: 'unwired',
    error: null,
    lastUpdatedAt: null,
    isRefreshing: false,
    refresh: vi.fn(),
    phase: 'Phase 3 — Liveness and escalation',
    ...overrides,
  };
}

const run: RunSummary = {
  id: 'run-1',
  workOrder: {
    id: 'wo_opifex_312_a3f91c2_a1',
    issueNumber: 312,
    repository: 'opifex/opifex',
    baseCommit: 'a3f91c2',
    attempt: 1,
    branch: 'factory/312-a3f91c2-a1',
    title: 'Add the run queue endpoint',
    issueUrl: null,
  },
  status: 'stalled',
  startedAt: new Date().toISOString(),
  lastEventAt: new Date().toISOString(),
  attentionReason: 'No events for 12 minutes.',
  resumesAt: null,
  runner: 'claude-code-local',
  costUsd: null,
  pullRequestUrl: null,
};

describe('AttentionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHook.mockReturnValue(hookResult());
  });

  it('titles itself and links to the full run list', () => {
    render(<AttentionPanel />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Needs attention' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All runs' })).toHaveAttribute(
      'href',
      '/runs',
    );
  });

  /**
   * The default state of the whole application today: there is no watchdog, so
   * this panel says exactly that and names the phase that will change it. It
   * must NOT read as "everything is fine".
   */
  describe('unwired', () => {
    it('explains that nothing is watching runs yet, and when that changes', () => {
      render(<AttentionPanel />);

      expect(
        screen.getByText(/Escalations appear here once the watchdog lands/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Arrives in Phase 3 — Liveness and escalation/),
      ).toBeInTheDocument();
    });

    it('does not claim anything about the health of any run', () => {
      render(<AttentionPanel />);
      expect(
        screen.queryByText(/Nothing needs attention/),
      ).not.toBeInTheDocument();
    });
  });

  /**
   * The opposite claim, and the reason `EmptyState` and `NotWiredState` are
   * two components. An operator who reads one as the other has been reassured
   * by a panel that never looked at a run.
   */
  describe('empty', () => {
    it('reports zero escalations as the good news it is', () => {
      mockHook.mockReturnValue(hookResult({ data: [], state: 'empty' }));

      render(<AttentionPanel />);

      expect(screen.getByText('Nothing needs attention.')).toBeInTheDocument();
      // Blocked runs resume on their own (VISION §9) and are deliberately not
      // escalated; the empty state says so rather than leaving the operator to
      // wonder where they went.
      expect(
        screen.getByText(/Blocked runs resume on their own/),
      ).toBeInTheDocument();
    });

    it('does not name a roadmap phase — there is nothing left to build here', () => {
      mockHook.mockReturnValue(hookResult({ data: [], state: 'empty' }));

      render(<AttentionPanel />);

      expect(screen.queryByText(/Arrives in/)).not.toBeInTheDocument();
    });
  });

  describe('ready', () => {
    it('renders one list item per escalated run', () => {
      mockHook.mockReturnValue(
        hookResult({ data: [run, { ...run, id: 'run-2' }], state: 'ready' }),
      );

      render(<AttentionPanel />);

      expect(screen.getAllByRole('listitem')).toHaveLength(2);
      expect(screen.getAllByText('wo_opifex_312_a3f91c2_a1')).toHaveLength(2);
    });
  });

  describe('error', () => {
    it('surfaces a failure that left nothing to show', () => {
      mockHook.mockReturnValue(
        hookResult({ state: 'error', error: 'network down' }),
      );

      render(<AttentionPanel />);

      expect(screen.getByRole('alert')).toHaveTextContent('network down');
    });

    it('keeps the rows and warns when a re-poll failed over existing data', () => {
      mockHook.mockReturnValue(
        hookResult({ data: [run], state: 'ready', error: 'network down' }),
      );

      render(<AttentionPanel />);

      expect(screen.getByText('wo_opifex_312_a3f91c2_a1')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(/last known data/i);
    });
  });
});
