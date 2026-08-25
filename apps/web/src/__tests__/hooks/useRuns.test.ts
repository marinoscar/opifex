/**
 * `useRuns` — the runs table's data source (#82), and the worst case of #246.
 *
 * The polling machinery is `usePolledResource`'s and is tested exhaustively in
 * `usePolledResource.test.ts`. What is tested here is the binding that the
 * cockpit's most-used table depends on: every control on `/runs` — the pager,
 * the sort headers, the status filter — is wired by rebuilding the fetcher, and
 * until #246 none of them issued a request. Clicking "next page" did nothing
 * visible for up to 30 seconds, and the hook carried a comment asserting the
 * opposite, which is presumably why it survived review.
 *
 * Real timers throughout: nothing here should need a tick, and a test that
 * passes only after advancing one would be asserting the bug.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { renderHookWithProviders } from '../utils/hook-utils';

vi.mock('../../config/cockpitApi', () => ({
  COCKPIT_POLL_INTERVAL_MS: 30_000,
}));

vi.mock('../../services/api', () => ({
  getRuns: vi.fn(),
}));

import { useRuns, type UseRunsParams } from '../../hooks/useRuns';
import { getRuns } from '../../services/api';

const mockGetRuns = vi.mocked(getRuns);

const EMPTY = { items: [], total: 0, page: 1, pageSize: 25 };

const FIRST_PAGE: UseRunsParams = { page: 1, pageSize: 25 };

function renderRuns(initialProps: UseRunsParams = FIRST_PAGE) {
  return renderHookWithProviders((params: UseRunsParams) => useRuns(params), {
    initialProps,
  });
}

describe('useRuns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRuns.mockResolvedValue(EMPTY);
  });

  it('reads the first page on mount', async () => {
    renderRuns();
    await act(async () => {});

    expect(mockGetRuns).toHaveBeenCalledTimes(1);
    expect(mockGetRuns).toHaveBeenCalledWith(
      {
        page: 1,
        pageSize: 25,
        status: undefined,
        sort: undefined,
        direction: undefined,
      },
      expect.any(AbortSignal),
    );
  });

  /** The regression that shipped: no timer is advanced anywhere below. */
  it('reads again when the page changes', async () => {
    const { rerender } = renderRuns();
    await act(async () => {});

    await act(async () => {
      rerender({ page: 2, pageSize: 25 });
    });

    expect(mockGetRuns).toHaveBeenCalledTimes(2);
    expect(mockGetRuns).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2 }),
      expect.any(AbortSignal),
    );
  });

  it('reads again when the status filter changes', async () => {
    const { rerender } = renderRuns();
    await act(async () => {});

    await act(async () => {
      rerender({ ...FIRST_PAGE, status: 'failed' });
    });

    expect(mockGetRuns).toHaveBeenCalledTimes(2);
    expect(mockGetRuns).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed' }),
      expect.any(AbortSignal),
    );
  });

  it('reads again when the sort changes', async () => {
    const { rerender } = renderRuns();
    await act(async () => {});

    await act(async () => {
      rerender({ ...FIRST_PAGE, sort: 'startedAt', direction: 'asc' });
    });

    expect(mockGetRuns).toHaveBeenCalledTimes(2);
    expect(mockGetRuns).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'startedAt', direction: 'asc' }),
      expect.any(AbortSignal),
    );
  });

  /**
   * `RunsPage` passes a fresh params object every render. Keying on the object
   * would make that a request per render — the failure mode #246 rejects by
   * name, and the reason the key is the five values rather than the object.
   */
  it('does not read again when a re-render changes nothing', async () => {
    const { rerender } = renderRuns();
    await act(async () => {});

    await act(async () => {
      rerender({ page: 1, pageSize: 25 });
      rerender({ page: 1, pageSize: 25 });
    });

    expect(mockGetRuns).toHaveBeenCalledTimes(1);
  });
});
