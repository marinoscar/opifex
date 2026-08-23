/**
 * `useActivityFeed` — see `useCockpitMetrics.test.ts` for the shape of these
 * four thin binding suites.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { renderHookWithProviders } from '../utils/hook-utils';

const { endpoints } = vi.hoisted(() => ({
  endpoints: {
    activity: {
      path: '/events?limit=20',
      available: false,
      phase: 'Phase 2 — Reconciler, read-only',
    },
  },
}));

vi.mock('../../config/cockpitApi', () => ({
  COCKPIT_ENDPOINTS: endpoints,
  COCKPIT_POLL_INTERVAL_MS: 1000,
}));

vi.mock('../../services/api', () => ({
  getActivityFeed: vi.fn(),
}));

import {
  useActivityFeed,
  ACTIVITY_FEED_LIMIT,
} from '../../hooks/useActivityFeed';
import { getActivityFeed } from '../../services/api';

const mockGet = vi.mocked(getActivityFeed);

describe('useActivityFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    endpoints.activity.available = false;
  });

  it('requests nothing while no reconciler is observing anything', async () => {
    const { result } = renderHookWithProviders(() => useActivityFeed());

    expect(mockGet).not.toHaveBeenCalled();
    expect(result.current.state).toBe('unwired');
    // The earliest phase of the four panels: events land before dispatch does.
    expect(result.current.phase).toBe('Phase 2 — Reconciler, read-only');
  });

  it('asks for a dashboard-sized slice rather than the endpoint default', async () => {
    endpoints.activity.available = true;
    mockGet.mockResolvedValue([]);

    renderHookWithProviders(() => useActivityFeed());
    await act(async () => {});

    expect(ACTIVITY_FEED_LIMIT).toBeLessThan(20);
    expect(mockGet).toHaveBeenCalledWith(
      { limit: ACTIVITY_FEED_LIMIT },
      expect.any(AbortSignal),
    );
  });
});
