/**
 * `useRunQueue` — see `useCockpitMetrics.test.ts` for the shape of these four
 * thin binding suites.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { renderHookWithProviders } from '../utils/hook-utils';

const { endpoints } = vi.hoisted(() => ({
  endpoints: {
    queue: { path: '/queue', available: false, phase: 'Phase 4 — Execution' },
  },
}));

vi.mock('../../config/cockpitApi', () => ({
  COCKPIT_ENDPOINTS: endpoints,
  COCKPIT_POLL_INTERVAL_MS: 1000,
}));

vi.mock('../../services/api', () => ({
  getRunQueue: vi.fn(),
}));

import { useRunQueue, QUEUE_PANEL_LIMIT } from '../../hooks/useRunQueue';
import { getRunQueue } from '../../services/api';

const mockGet = vi.mocked(getRunQueue);

describe('useRunQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    endpoints.queue.available = false;
  });

  it('requests nothing while nothing dispatches', async () => {
    const { result } = renderHookWithProviders(() => useRunQueue());

    expect(mockGet).not.toHaveBeenCalled();
    expect(result.current.state).toBe('unwired');
    expect(result.current.phase).toBe('Phase 4 — Execution');
  });

  it('fetches the panel-sized page once the endpoint exists', async () => {
    endpoints.queue.available = true;
    mockGet.mockResolvedValue([]);

    renderHookWithProviders(() => useRunQueue());
    await act(async () => {});

    expect(mockGet).toHaveBeenCalledWith({ limit: QUEUE_PANEL_LIMIT }, expect.any(AbortSignal));
  });

  it('honours an explicit limit', async () => {
    endpoints.queue.available = true;
    mockGet.mockResolvedValue([]);

    renderHookWithProviders(() => useRunQueue(20));
    await act(async () => {});

    expect(mockGet).toHaveBeenCalledWith({ limit: 20 }, expect.any(AbortSignal));
  });
});
