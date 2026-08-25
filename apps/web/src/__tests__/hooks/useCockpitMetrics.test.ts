/**
 * `useCockpitMetrics` — thin by design.
 *
 * The polling behaviour is `usePolledResource`'s and is tested exhaustively in
 * its own suite. What is worth asserting here is the BINDING: that the hook
 * reads `available` from the endpoint registry into `enabled` (so nothing is
 * requested while the endpoint does not exist), that it surfaces the registry's
 * roadmap phase for the panel to display, and that it calls the right API
 * function with a forwarded abort signal once the registry flips.
 *
 * The registry is mocked with a MUTABLE stand-in so both sides of that flip can
 * be exercised in one file. That mattered when the real registry was
 * `available: false` everywhere, and it still matters now that it is `true`
 * everywhere: a test that could only see the live half would no longer prove
 * that `available: false` suppresses the request at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { renderHookWithProviders } from '../utils/hook-utils';

const { endpoints } = vi.hoisted(() => ({
  endpoints: {
    metrics: {
      path: '/metrics/summary',
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
  getCockpitMetrics: vi.fn(),
}));

import { useCockpitMetrics } from '../../hooks/useCockpitMetrics';
import { getCockpitMetrics } from '../../services/api';

const mockGet = vi.mocked(getCockpitMetrics);

describe('useCockpitMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    endpoints.metrics.available = false;
  });

  it('requests nothing while the endpoint does not exist', async () => {
    const { result } = renderHookWithProviders(() => useCockpitMetrics());

    expect(mockGet).not.toHaveBeenCalled();
    expect(result.current.state).toBe('unwired');
    expect(result.current.data).toBeNull();
  });

  it('surfaces the roadmap phase so the panel can name it', () => {
    const { result } = renderHookWithProviders(() => useCockpitMetrics());
    expect(result.current.phase).toBe('Phase 3 — Liveness and escalation');
  });

  it('fetches through the typed API function once the endpoint exists', async () => {
    endpoints.metrics.available = true;
    mockGet.mockResolvedValue({
      generatedAt: '2026-08-19T12:00:00.000Z',
      window: {
        from: '2026-08-12T12:00:00.000Z',
        to: '2026-08-19T12:00:00.000Z',
      },
      metrics: {
        detectionLatency: { value: 45, trend: [] },
        deadTimePerDay: { value: 1, trend: [] },
        firstPassAcceptance: { value: 0.8, trend: [] },
        attemptsPerWorkOrder: { value: 1.2, trend: [] },
        costPerMergedPr: { value: 10, trend: [] },
        quotaBurn: { value: 0.5, trend: [] },
      },
    });

    const { result } = renderHookWithProviders(() => useCockpitMetrics());
    await act(async () => {});

    expect(mockGet).toHaveBeenCalledTimes(1);
    // The signal is forwarded, or an aborted request would keep running.
    expect(mockGet.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(result.current.state).toBe('ready');
  });
});
