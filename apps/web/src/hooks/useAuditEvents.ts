/**
 * A page of the audit log (#351, epic #332).
 *
 * Controlled, like `useRuns`: the section owns the page, the page size and the
 * target-type filter, and every one of them is answered by the SERVER. An
 * audit table grows without bound, so filtering a page of 25 in the browser
 * would filter a page rather than the log — and this is the one screen where
 * "I could not find that change" has to mean it did not happen.
 *
 * Polled through `usePolledResource` like every other read-only surface here.
 * The interval earns its keep on this screen in a way it does not on all of
 * them: an operator changing a setting in the Configuration section and then
 * opening History expects to see their own change, and a table that only
 * refreshed on remount would show the world as it was before they acted.
 */

import { useCallback } from 'react';

import { COCKPIT_POLL_INTERVAL_MS } from '../config/cockpitApi';
import { getAuditEvents } from '../services/api';
import type { AuditEventsPage } from '../types/audit';
import { usePolledResource } from './usePolledResource';
import type { UsePolledResourceResult } from './usePolledResource';

export interface UseAuditEventsParams {
  page: number;
  pageSize: number;
  /** `operator_settings`, `system_settings`, … Omitted means the whole log. */
  targetType?: string;
}

export function useAuditEvents({
  page,
  pageSize,
  targetType,
}: UseAuditEventsParams): UsePolledResourceResult<AuditEventsPage> {
  // Every parameter appears twice deliberately — in the fetcher's dependencies
  // so the closure reads current values, and in `fetcherKey`, which is what
  // makes a change re-read NOW rather than on the next tick (#246).
  const fetcher = useCallback(
    (signal: AbortSignal) =>
      getAuditEvents({ page, pageSize, targetType }, signal),
    [page, pageSize, targetType],
  );

  return usePolledResource<AuditEventsPage>({
    fetcher,
    fetcherKey: [page, pageSize, targetType],
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    // The endpoint exists (#338). `enabled: false` is how this app says "not
    // built yet", and there is nothing to say.
    enabled: true,
    // An envelope with no items IS empty — the default only knows about bare
    // arrays, and without this a filter that matches nothing would report
    // `ready` with zero rows rather than the empty state.
    isEmpty: (data) => data.items.length === 0,
  });
}
