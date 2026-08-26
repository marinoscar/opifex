/**
 * The Control Center's readiness read (#347, epic #332).
 *
 * Reads the two endpoints the chain rests on — `/health/ready` for the fleet
 * and `/repositories` for the enablement count — and hands both, plus whatever
 * went wrong with either, to the pure chain builder in `config/readiness.ts`.
 *
 * ## One fetcher that never rejects
 *
 * The two reads fail INDEPENDENTLY and for different reasons: readiness only
 * goes red when the control plane cannot reach its own database, while
 * `/repositories` requires `projects:read`, which an operator holding
 * `system_settings:read` may simply not have. A `Promise.all` would let a 403
 * on the second blank the fleet reported by the first, which is the one thing
 * this screen must not do — a failure to READ a step is a different claim from
 * the step failing, and both are different again from the step having no probe
 * at all. So each read is caught here and carried as a reason string, and the
 * fetcher resolves either way.
 *
 * Polled through `usePolledResource` like every other read-only surface in
 * this app: fleet registration converges on a 60-second tick, so a screen an
 * operator is watching while they flip a flag has to re-read on its own or it
 * would report the pre-flip world indefinitely.
 */

import { useCallback } from 'react';

import { COCKPIT_POLL_INTERVAL_MS } from '../config/cockpitApi';
import {
  buildReadinessChain,
  summariseReadiness,
  type ReadinessInputs,
  type ReadinessStep,
  type ReadinessSummary,
} from '../config/readiness';
import {
  ApiError,
  fleetFromReadiness,
  getReadinessHealth,
  getRepositoryEnablementCounts,
} from '../services/api';
import type { FleetHealth } from '../types/health';
import { usePolledResource } from './usePolledResource';

export interface UseReadinessResult {
  steps: ReadinessStep[];
  summary: ReadinessSummary;
  /**
   * The fleet as this read found it, or null when it could not be read.
   *
   * Exposed alongside the chain because the Configuration section (#348) shows
   * the observed counterpart of a setting beside its configured value, and
   * this payload is the only place the API publishes an observation of one —
   * `enabled` and `maxConcurrency` read back off the registered runner. A
   * second poll of `/health/ready` from that section would have shown a
   * different instant on the same screen.
   */
  fleet: FleetHealth | null;
  /** When the observations on screen were last read successfully. */
  lastUpdatedAt: Date | null;
  isRefreshing: boolean;
  /** True until the first read settles. Nothing has been observed yet. */
  isLoading: boolean;
  refresh: () => Promise<void>;
}

async function readInputs(signal: AbortSignal): Promise<ReadinessInputs> {
  const inputs: ReadinessInputs = {
    fleet: null,
    fleetError: null,
    repositories: null,
    repositoriesError: null,
  };

  const [health, repositories] = await Promise.allSettled([
    getReadinessHealth(signal),
    getRepositoryEnablementCounts(signal),
  ]);

  if (health.status === 'fulfilled') {
    inputs.fleet = fleetFromReadiness(health.value);
    if (!inputs.fleet) {
      inputs.fleetError =
        'The readiness probe answered without a fleet entry, so nothing ' +
        'reported on the runners.';
    }
  } else {
    inputs.fleetError = describeFailure(
      health.reason,
      'GET /api/health/ready',
      'The readiness probe is red, which for that endpoint means the API ' +
        'could not reach its own database — an empty or disabled fleet is ' +
        'reported there rather than failed.',
    );
  }

  if (repositories.status === 'fulfilled') {
    inputs.repositories = repositories.value;
  } else {
    inputs.repositoriesError = describeFailure(
      repositories.reason,
      'GET /api/repositories',
      'Reading the repository list needs `projects:read`, which this ' +
        'account does not hold. Not verifiable here — it is not zero.',
    );
  }

  return inputs;
}

/**
 * Why a read did not answer, said as a fact about the read.
 *
 * A 403 gets its own sentence because it is the case most likely to be
 * misread as bad news about the deployment: it is bad news about the ACCOUNT,
 * and the step it feeds must say "not verifiable with these permissions"
 * rather than render a zero nobody measured.
 */
function describeFailure(
  reason: unknown,
  source: string,
  forbidden: string,
): string {
  if (reason instanceof ApiError && reason.status === 403) return forbidden;
  if (reason instanceof ApiError) {
    return `${source} answered ${reason.status}: ${reason.message}`;
  }
  return reason instanceof Error
    ? `${source} could not be read: ${reason.message}`
    : `${source} could not be read.`;
}

export function useReadiness(): UseReadinessResult {
  const fetcher = useCallback((signal: AbortSignal) => readInputs(signal), []);

  const { data, lastUpdatedAt, isRefreshing, refresh } =
    usePolledResource<ReadinessInputs>({
      fetcher,
      // Nothing parameterises this read: the chain is the same chain for every
      // operator. `[]` is the claim, and it is one a reviewer can check.
      fetcherKey: [],
      intervalMs: COCKPIT_POLL_INTERVAL_MS,
      enabled: true,
    });

  // Before the first read lands there is nothing to build a chain from, and a
  // chain built from nulls would show five grey rows that look like findings.
  // The caller renders a spinner on `isLoading` instead.
  const inputs: ReadinessInputs = data ?? {
    fleet: null,
    fleetError: null,
    repositories: null,
    repositoriesError: null,
  };

  const steps = buildReadinessChain(inputs);

  return {
    steps,
    summary: summariseReadiness(steps),
    fleet: inputs.fleet,
    lastUpdatedAt,
    isRefreshing,
    isLoading: data === null,
    refresh,
  };
}
