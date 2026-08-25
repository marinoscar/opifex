/**
 * `useApprovalQueue` — the case #246 was actually reported against.
 *
 * "Select `parked` on `/approvals` and nothing happens; 30 seconds later the
 * list changes on its own." The polling machinery itself is tested in
 * `usePolledResource.test.ts`; what is pinned here is that this hook declares
 * its filters, so a filter change is a request rather than a re-render.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { renderHookWithProviders } from '../utils/hook-utils';

vi.mock('../../config/cockpitApi', () => ({
  COCKPIT_POLL_INTERVAL_MS: 30_000,
}));

vi.mock('../../services/api', () => ({
  getApprovals: vi.fn(),
  getApproval: vi.fn(),
}));

import {
  useApprovalQueue,
  type ApprovalQueueFilters,
} from '../../hooks/useApprovals';
import { getApprovals } from '../../services/api';

const mockGetApprovals = vi.mocked(getApprovals);

function renderQueue(initialProps: ApprovalQueueFilters = {}) {
  return renderHookWithProviders(
    (filters: ApprovalQueueFilters) => useApprovalQueue(filters),
    { initialProps },
  );
}

describe('useApprovalQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApprovals.mockResolvedValue([]);
  });

  it('reads the unfiltered queue on mount', async () => {
    renderQueue();
    await act(async () => {});

    expect(mockGetApprovals).toHaveBeenCalledTimes(1);
    expect(mockGetApprovals).toHaveBeenCalledWith({}, expect.any(AbortSignal));
  });

  /** No timer is advanced: the request is issued now, or the bug is back. */
  it('reads again when the status filter changes', async () => {
    const { rerender } = renderQueue();
    await act(async () => {});

    await act(async () => {
      rerender({ status: 'parked' });
    });

    expect(mockGetApprovals).toHaveBeenCalledTimes(2);
    expect(mockGetApprovals).toHaveBeenLastCalledWith(
      { status: 'parked' },
      expect.any(AbortSignal),
    );
  });

  it('reads again when the repository filter changes', async () => {
    const { rerender } = renderQueue({ status: 'pending' });
    await act(async () => {});

    await act(async () => {
      rerender({ status: 'pending', repositoryId: 'repo-1' });
    });

    expect(mockGetApprovals).toHaveBeenCalledTimes(2);
    expect(mockGetApprovals).toHaveBeenLastCalledWith(
      { status: 'pending', repositoryId: 'repo-1' },
      expect.any(AbortSignal),
    );
  });

  /**
   * `ApprovalsPage` passes an inline `{}` when nothing is filtered, so a new
   * object every render must not be a new request.
   */
  it('does not read again when a re-render changes no filter', async () => {
    const { rerender } = renderQueue();
    await act(async () => {});

    await act(async () => {
      rerender({});
      rerender({});
    });

    expect(mockGetApprovals).toHaveBeenCalledTimes(1);
  });
});
