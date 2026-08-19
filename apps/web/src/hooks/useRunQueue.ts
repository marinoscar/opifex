/**
 * The dispatch queue, polled.
 *
 * Epic #19. Queue depth is how the operator sees VISION §11's shared-quota
 * pressure before it becomes a stall: work orders piling up waiting for
 * capacity is the leading indicator, and a run going silent is the lagging one.
 */

import { useCallback } from 'react';
import { COCKPIT_ENDPOINTS, COCKPIT_POLL_INTERVAL_MS } from '../config/cockpitApi';
import { getRunQueue } from '../services/api';
import type { QueueEntry } from '../types/cockpit';
import { usePolledResource } from './usePolledResource';
import type { UsePolledResourceResult } from './usePolledResource';

/** Rows the dashboard panel shows before deferring to `/queue`. */
export const QUEUE_PANEL_LIMIT = 5;

export interface UseRunQueueResult extends UsePolledResourceResult<QueueEntry[]> {
  phase: string;
}

export function useRunQueue(limit: number = QUEUE_PANEL_LIMIT): UseRunQueueResult {
  const endpoint = COCKPIT_ENDPOINTS.queue;

  const fetcher = useCallback((signal: AbortSignal) => getRunQueue({ limit }, signal), [
    limit,
  ]);

  const resource = usePolledResource<QueueEntry[]>({
    fetcher,
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    enabled: endpoint.available,
  });

  return { ...resource, phase: endpoint.phase };
}
