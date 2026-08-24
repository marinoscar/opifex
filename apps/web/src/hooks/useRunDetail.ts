/**
 * One run and its timeline, polled (#83, epic #20).
 *
 * Two resources rather than one, because they have different shapes and
 * different lifetimes: the run is a single object that changes as it executes,
 * the timeline is a paged list that only ever grows. Folding them into one
 * fetch would mean re-reading page four of the events every time the run's cost
 * ticked up.
 */

import { useCallback } from 'react';
import { COCKPIT_POLL_INTERVAL_MS } from '../config/cockpitApi';
import { getRun, getRunEvents, type RunEventsPage } from '../services/api';
import type { RunDetail } from '../types/cockpit';
import { usePolledResource } from './usePolledResource';
import type { UsePolledResourceResult } from './usePolledResource';

export const RUN_EVENTS_PAGE_SIZE = 50;

export function useRun(id: string): UsePolledResourceResult<RunDetail> {
  const fetcher = useCallback(
    (signal: AbortSignal) => getRun(id, signal),
    [id],
  );

  return usePolledResource<RunDetail>({
    fetcher,
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    // An id that has not arrived yet must not fire a request for `/runs/`.
    enabled: Boolean(id),
  });
}

export function useRunEvents(
  id: string,
  page: number,
  pageSize: number = RUN_EVENTS_PAGE_SIZE,
): UsePolledResourceResult<RunEventsPage> {
  const fetcher = useCallback(
    (signal: AbortSignal) => getRunEvents(id, { page, pageSize }, signal),
    [id, page, pageSize],
  );

  return usePolledResource<RunEventsPage>({
    fetcher,
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    enabled: Boolean(id),
  });
}
