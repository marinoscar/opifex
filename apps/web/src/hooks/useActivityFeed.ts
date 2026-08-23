/**
 * The normalized event stream (VISION §9), polled.
 *
 * Epic #19. This is the first cockpit panel that can ever be wired, because
 * events arrive in Phase 2 — the read-only reconciler — long before anything
 * is dispatched. It is also the panel that most needs its `source` label
 * rendered: VISION §9 is explicit that "a synthesized event must never
 * masquerade as a report", and two independent liveness sources are only worth
 * having if the operator can tell which one spoke.
 */

import { useCallback } from 'react';
import {
  COCKPIT_ENDPOINTS,
  COCKPIT_POLL_INTERVAL_MS,
} from '../config/cockpitApi';
import { getActivityFeed } from '../services/api';
import type { RunEvent } from '../types/cockpit';
import { usePolledResource } from './usePolledResource';
import type { UsePolledResourceResult } from './usePolledResource';

/**
 * How many events the panel asks for.
 *
 * Ten rather than the endpoint's default twenty: this is a "what just
 * happened" glance on a dashboard shared with three other panels. The full
 * stream belongs on a run's own page, where it can be paged and filtered.
 */
export const ACTIVITY_FEED_LIMIT = 10;

export interface UseActivityFeedResult extends UsePolledResourceResult<
  RunEvent[]
> {
  phase: string;
}

export function useActivityFeed(
  limit: number = ACTIVITY_FEED_LIMIT,
): UseActivityFeedResult {
  const endpoint = COCKPIT_ENDPOINTS.activity;

  const fetcher = useCallback(
    (signal: AbortSignal) => getActivityFeed({ limit }, signal),
    [limit],
  );

  const resource = usePolledResource<RunEvent[]>({
    fetcher,
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    enabled: endpoint.available,
  });

  return { ...resource, phase: endpoint.phase };
}
