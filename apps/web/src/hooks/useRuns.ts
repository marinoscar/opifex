/**
 * A page of runs, polled (#82, epic #20).
 *
 * Unlike `useRunsNeedingAttention`, this one is CONTROLLED: the page owns
 * pagination, sorting and the status filter, and every one of them is answered
 * by the server. Filtering or sorting a page of 25 rows in the browser would
 * be sorting a page, not the result set — it looks identical until the moment
 * an operator needs the oldest silent run and it is on page four.
 */

import { useCallback } from 'react';
import { COCKPIT_POLL_INTERVAL_MS } from '../config/cockpitApi';
import { getRuns, type RunSortField, type RunsPage } from '../services/api';
import type { RunStatus } from '../types/cockpit';
import { usePolledResource } from './usePolledResource';
import type { UsePolledResourceResult } from './usePolledResource';

export interface UseRunsParams {
  page: number;
  pageSize: number;
  status?: RunStatus;
  sort?: RunSortField;
  direction?: 'asc' | 'desc';
}

export function useRuns(
  params: UseRunsParams,
): UsePolledResourceResult<RunsPage> {
  const { page, pageSize, status, sort, direction } = params;

  // Every parameter appears twice on purpose: in the fetcher's dependencies,
  // so the closure reads current values, and in `fetcherKey` below, which is
  // what actually makes a change REFETCH. Until #246 only the first half was
  // here, and clicking "next page" issued no request for up to 30 seconds.
  const fetcher = useCallback(
    (signal: AbortSignal) =>
      getRuns({ page, pageSize, status, sort, direction }, signal),
    [page, pageSize, status, sort, direction],
  );

  return usePolledResource<RunsPage>({
    fetcher,
    fetcherKey: [page, pageSize, status, sort, direction],
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    enabled: true,
  });
}
