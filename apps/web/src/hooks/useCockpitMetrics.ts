/**
 * The six success metrics (VISION §10), polled.
 *
 * Epic #19. Thin by design: the interesting behaviour all lives in
 * `usePolledResource`, and everything this file adds is the binding between
 * one entry in `config/cockpitApi.ts` and one typed function in
 * `services/api.ts`.
 *
 * The one thing it adds beyond the poll result is `phase`. Without it every
 * panel would import the endpoint registry just to hand a string to
 * `NotWiredState`, and the "which phase delivers this" answer would be
 * duplicated at each call site — the exact duplication the registry exists to
 * remove.
 */

import { useCallback } from 'react';
import {
  COCKPIT_ENDPOINTS,
  COCKPIT_POLL_INTERVAL_MS,
} from '../config/cockpitApi';
import { getCockpitMetrics } from '../services/api';
import type { MetricsSummary } from '../types/cockpit';
import { usePolledResource } from './usePolledResource';
import type { UsePolledResourceResult } from './usePolledResource';

export interface UseCockpitMetricsResult extends UsePolledResourceResult<MetricsSummary> {
  /** The VISION §12 roadmap phase that will supply this, for `NotWiredState`. */
  phase: string;
}

export function useCockpitMetrics(): UseCockpitMetricsResult {
  const endpoint = COCKPIT_ENDPOINTS.metrics;

  const fetcher = useCallback(
    (signal: AbortSignal) => getCockpitMetrics(signal),
    [],
  );

  const resource = usePolledResource<MetricsSummary>({
    fetcher,
    // Nothing to key on: the summary takes no parameters.
    fetcherKey: [],
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    enabled: endpoint.available,
    // No `isEmpty`. A metrics summary is never "empty" — it is six readings,
    // any of which may individually be `null`, and each tile says `—` for its
    // own. An all-null summary is still a real answer from a real endpoint,
    // and collapsing it to one panel-wide empty state would hide which of the
    // six the control plane actually computed.
  });

  return { ...resource, phase: endpoint.phase };
}
