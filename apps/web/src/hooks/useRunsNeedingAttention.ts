/**
 * Runs the control plane says need a human, polled.
 *
 * Epic #19, VISION §9: "Escalation is an action, not telemetry." This is the
 * dashboard's most important list, and the reason the attention panel renders
 * ABOVE the metrics on a phone.
 *
 * The `needsAttention` filter is applied by the SERVER (see
 * `getRunsNeedingAttention` in `services/api.ts`). This hook deliberately does
 * not filter by status locally — the watchdog's verdict is the control plane's
 * to make, and a browser-side re-implementation of it would be a second,
 * lagging, silently divergent copy of the escalation rules.
 */

import { useCallback } from 'react';
import { COCKPIT_ENDPOINTS, COCKPIT_POLL_INTERVAL_MS } from '../config/cockpitApi';
import { getRunsNeedingAttention } from '../services/api';
import type { RunSummary } from '../types/cockpit';
import { usePolledResource } from './usePolledResource';
import type { UsePolledResourceResult } from './usePolledResource';

/**
 * How many escalations the dashboard panel asks for.
 *
 * Five, because the panel is a TRIAGE surface, not a work list: past about
 * five rows an operator stops reading and starts scanning, and the panel's job
 * is to be read. When there are more, the panel says so and links to `/runs`,
 * which is where the full, filterable, paginated table lives.
 */
export const ATTENTION_PANEL_LIMIT = 5;

export interface UseRunsNeedingAttentionResult
  extends UsePolledResourceResult<RunSummary[]> {
  phase: string;
}

export function useRunsNeedingAttention(
  limit: number = ATTENTION_PANEL_LIMIT,
): UseRunsNeedingAttentionResult {
  const endpoint = COCKPIT_ENDPOINTS.attention;

  const fetcher = useCallback(
    (signal: AbortSignal) => getRunsNeedingAttention({ limit }, signal),
    [limit],
  );

  const resource = usePolledResource<RunSummary[]>({
    fetcher,
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    enabled: endpoint.available,
    // The default array test is exactly right here, and the resulting `empty`
    // state is GOOD NEWS ("Nothing needs attention") rather than an absence —
    // which is why it renders through `EmptyState` and not `NotWiredState`.
  });

  return { ...resource, phase: endpoint.phase };
}
