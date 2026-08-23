/**
 * `useRunsNeedingAttention` — see `useCockpitMetrics.test.ts` for why these
 * four hook suites are thin and what the mutable registry mock is for.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { renderHookWithProviders } from '../utils/hook-utils';

const { endpoints } = vi.hoisted(() => ({
  endpoints: {
    attention: {
      path: '/runs?needsAttention=true',
      available: false,
      phase: 'Phase 3 — Liveness and escalation',
    },
  },
}));

vi.mock('../../config/cockpitApi', () => ({
  COCKPIT_ENDPOINTS: endpoints,
  COCKPIT_POLL_INTERVAL_MS: 1000,
}));

vi.mock('../../services/api', () => ({
  getRunsNeedingAttention: vi.fn(),
}));

import {
  useRunsNeedingAttention,
  ATTENTION_PANEL_LIMIT,
} from '../../hooks/useRunsNeedingAttention';
import { getRunsNeedingAttention } from '../../services/api';

const mockGet = vi.mocked(getRunsNeedingAttention);

describe('useRunsNeedingAttention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    endpoints.attention.available = false;
  });

  it('requests nothing while there is no watchdog to ask', async () => {
    const { result } = renderHookWithProviders(() => useRunsNeedingAttention());

    expect(mockGet).not.toHaveBeenCalled();
    expect(result.current.state).toBe('unwired');
    expect(result.current.phase).toBe('Phase 3 — Liveness and escalation');
  });

  it('asks for the panel-sized page by default', async () => {
    endpoints.attention.available = true;
    mockGet.mockResolvedValue([]);

    renderHookWithProviders(() => useRunsNeedingAttention());
    await act(async () => {});

    // Five, because the panel is a triage surface rather than a work list.
    expect(mockGet).toHaveBeenCalledWith(
      { limit: ATTENTION_PANEL_LIMIT },
      expect.any(AbortSignal),
    );
  });

  it('reports an empty escalation list as empty, not as unwired', async () => {
    endpoints.attention.available = true;
    mockGet.mockResolvedValue([]);

    const { result } = renderHookWithProviders(() => useRunsNeedingAttention());
    await act(async () => {});

    // "Nothing needs attention" and "there is no watchdog" are opposite claims
    // and must reach the panel as different states.
    expect(result.current.state).toBe('empty');
  });
});
