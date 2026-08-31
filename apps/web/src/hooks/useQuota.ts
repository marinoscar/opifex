/**
 * The three quota reads the `/quota` screen is built from (#231, #476).
 *
 * All three are polled through `usePolledResource`, like every other cockpit
 * resource, and all three are CONTROLLED where the endpoint takes parameters:
 * the page owns the range, the reason and the pagination, and the server
 * answers them. Filtering a page of 25 episodes in the browser would filter a
 * PAGE rather than the result set — it looks identical right up to the moment
 * an operator needs the block that started the afternoon and it is on page
 * four.
 *
 * `enabled: true` unconditionally rather than through
 * `config/cockpitApi.ts`: that registry describes the four DASHBOARD panels,
 * and `QuotaController` has served all three of these routes since #231 and
 * #476 respectively. Adding entries to it for endpoints that already exist
 * would be recording a "does this exist yet" question that has an answer.
 *
 * Every `setState` past an `await` lives inside `usePolledResource`, which
 * guards them with `useIsMounted()` — the house rule from `useUsers.ts`.
 */

import { useCallback } from 'react';
import { COCKPIT_POLL_INTERVAL_MS } from '../config/cockpitApi';
import {
  getQuotaEvents,
  getQuotaSummary,
  getQuotaWindows,
  type QuotaEventsPage,
  type QuotaWindowsPage,
} from '../services/api';
import type { QuotaSummary, RateLimitReason } from '../types/quota';
import { usePolledResource } from './usePolledResource';
import type { UsePolledResourceResult } from './usePolledResource';

/**
 * The live gauge.
 *
 * `isEmpty` is stated explicitly because the default — "an empty array is
 * empty" — cannot see inside the envelope. An empty `runners` list is a REAL
 * answer (#231's last acceptance criterion): a fleet whose runners report no
 * rate-limit signal at all has an unknown quota position, not a healthy one,
 * and the panel says so rather than drawing nothing.
 */
export function useQuotaSummary(): UsePolledResourceResult<QuotaSummary> {
  const fetcher = useCallback(
    (signal: AbortSignal) => getQuotaSummary(signal),
    [],
  );

  return usePolledResource<QuotaSummary>({
    fetcher,
    fetcherKey: [],
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    enabled: true,
    isEmpty: (summary) => summary.runners.length === 0,
  });
}

export interface UseQuotaEventsParams {
  page: number;
  pageSize: number;
  /** Inclusive ISO lower bound on `occurredAt`. Undefined means all of time. */
  since?: string;
  /** Inclusive ISO upper bound on `occurredAt`. */
  until?: string;
  runnerKey?: string;
  reason?: RateLimitReason;
}

/**
 * A page of rate-limit episodes.
 *
 * Every parameter appears twice on purpose: in the fetcher's dependencies, so
 * the closure reads current values, and in `fetcherKey`, which is what
 * actually makes a change REFETCH rather than wait out the poll interval
 * (#246).
 */
export function useQuotaEvents(
  params: UseQuotaEventsParams,
): UsePolledResourceResult<QuotaEventsPage> {
  const { page, pageSize, since, until, runnerKey, reason } = params;

  const fetcher = useCallback(
    (signal: AbortSignal) =>
      getQuotaEvents(
        { page, pageSize, since, until, runnerKey, reason },
        signal,
      ),
    [page, pageSize, since, until, runnerKey, reason],
  );

  return usePolledResource<QuotaEventsPage>({
    fetcher,
    fetcherKey: [page, pageSize, since, until, runnerKey, reason],
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    enabled: true,
    isEmpty: (result) => result.items.length === 0,
  });
}

export interface UseQuotaWindowsParams {
  page: number;
  pageSize: number;
  /**
   * The same two bounds the episodes take, testing a different predicate.
   *
   * On this endpoint they are an OVERLAP test against the window's observation
   * span, not a comparison against a single instant — so a window first
   * sighted before the range and still exhausted inside it is returned. The
   * hook passes them through untouched; reconciling them here would be a
   * second implementation of a rule the API already owns.
   */
  since?: string;
  until?: string;
  runnerKey?: string;
}

/** A page of windows that ever hit the wall. */
export function useQuotaWindows(
  params: UseQuotaWindowsParams,
): UsePolledResourceResult<QuotaWindowsPage> {
  const { page, pageSize, since, until, runnerKey } = params;

  const fetcher = useCallback(
    (signal: AbortSignal) =>
      getQuotaWindows({ page, pageSize, since, until, runnerKey }, signal),
    [page, pageSize, since, until, runnerKey],
  );

  return usePolledResource<QuotaWindowsPage>({
    fetcher,
    fetcherKey: [page, pageSize, since, until, runnerKey],
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    enabled: true,
    isEmpty: (result) => result.items.length === 0,
  });
}
