/**
 * Trust grants and the promotion ladder, polled (#101, epic #22).
 *
 * Every read hook is `usePolledResource` like the rest of the cockpit, so they
 * inherit its five load-bearing behaviours. Two of them matter more here than
 * almost anywhere: a failed poll never blanks what is on screen (an operator
 * reading a grant's four attributes to decide whether to revoke it must not
 * have them yanked away by one flaky request), and polling pauses while the
 * tab is hidden.
 *
 * Polling also does real work on this screen rather than merely refreshing a
 * count: `msUntilExpiry`, `remainingBudgetUsd`, `nearExpiry` and `nearBudget`
 * are computed relative to the moment of the READ, so a tab left open goes
 * stale in a way that matters — a grant that was "expires in 2h" when the page
 * loaded is a lapsed grant an hour later. Re-reading is how the screen stays
 * true, and it is also why none of those fields is recomputed in the browser.
 *
 * `enabled` is `true` unconditionally rather than read from
 * `config/cockpitApi.ts`: these endpoints exist. That registry expresses "not
 * built yet", and there is nothing to express.
 */

import { useCallback, useEffect, useRef } from 'react';
import { COCKPIT_POLL_INTERVAL_MS } from '../config/cockpitApi';
import {
  getPromotionLadder,
  getTrustGrant,
  getTrustGrants,
} from '../services/api';
import type {
  PromotionLadder,
  TrustGrantDetail,
  TrustGrantFilters,
  TrustGrantListItem,
} from '../types/trust';
import { usePolledResource } from './usePolledResource';
import type { UsePolledResourceResult } from './usePolledResource';

/**
 * Every grant matching the filters, NEWEST FIRST.
 *
 * The order is the server's and is passed through untouched, the same rule
 * `useApprovalQueue` follows — the endpoint accepts no `sort`, so a sortable
 * header would sort a page rather than the list and quietly lie about it.
 */
export function useTrustGrants(
  filters: TrustGrantFilters = {},
): UsePolledResourceResult<TrustGrantListItem[]> {
  const { repositoryId, actionClass, status, includeEnded } = filters;

  // Primitive dependencies rather than the object: a caller passing an inline
  // `{}` would otherwise rebuild the fetcher every render.
  const fetcher = useCallback(
    (signal: AbortSignal) =>
      getTrustGrants(
        {
          ...(repositoryId ? { repositoryId } : {}),
          ...(actionClass ? { actionClass } : {}),
          ...(status ? { status } : {}),
          ...(includeEnded ? { includeEnded: true } : {}),
        },
        signal,
      ),
    [repositoryId, actionClass, status, includeEnded],
  );

  const grants = usePolledResource<TrustGrantListItem[]>({
    fetcher,
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    enabled: true,
  });

  // `usePolledResource` holds its fetcher in a ref on purpose — a caller's
  // inline arrow function is a new identity every render, and depending on it
  // would rebuild the timer before it ever ticked. The cost is that a NEW
  // fetcher does not by itself trigger a read, so a filter change would
  // otherwise leave the old rows on screen until the next 30s tick, under a
  // control that says it changed something. `refresh()` is the supported way
  // to say "now": it supersedes the in-flight request rather than racing it.
  useRefetchOnChange(
    `${repositoryId ?? ''}|${actionClass ?? ''}|${status ?? ''}|${includeEnded ? '1' : '0'}`,
    grants.refresh,
  );

  return grants;
}

/**
 * Re-read whenever `key` changes, skipping the first render.
 *
 * The skip matters: `usePolledResource` already fetches immediately on mount,
 * and firing here as well would double every page load.
 */
function useRefetchOnChange(key: string, refresh: () => Promise<void>): void {
  const previous = useRef(key);

  useEffect(() => {
    if (previous.current === key) return;
    previous.current = key;
    void refresh();
  }, [key, refresh]);
}

/** One grant, with its registry entry and both halves of its renewal chain. */
export function useTrustGrant(
  id: string,
): UsePolledResourceResult<TrustGrantDetail> {
  const fetcher = useCallback(
    (signal: AbortSignal) => getTrustGrant(id, signal),
    [id],
  );

  return usePolledResource<TrustGrantDetail>({
    fetcher,
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    // An id that has not arrived yet must not fire a request for
    // `/trust/grants/`.
    enabled: Boolean(id),
  });
}

/**
 * The whole ladder, including the `enabled` switch above it.
 *
 * `isEmpty` is left at the default — an empty `states` array is not what makes
 * this resource empty, because the envelope still carries `enabled` and
 * `thresholds`, and "the ladder is switched off" is the most important thing a
 * response with no states can say. The default treats a non-array as non-empty,
 * which is exactly right here.
 */
export function usePromotionLadder(): UsePolledResourceResult<PromotionLadder> {
  const fetcher = useCallback(
    (signal: AbortSignal) => getPromotionLadder(signal),
    [],
  );

  return usePolledResource<PromotionLadder>({
    fetcher,
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    enabled: true,
  });
}

/*
 * There is deliberately NO `usePromotionState` hook for
 * `GET /promotion/states/:actionClass`.
 *
 * The endpoint exists and `services/api.ts` wraps it — it is the right read
 * for a future per-class deep link, which is why the client function stays —
 * but nothing in this app routes to one class today. A hook with no consumer
 * is React code that nothing renders and nothing exercises, and it rots
 * silently; the client function is a five-line fetch that the API-client test
 * covers directly. When the deep link lands, the hook is four lines away.
 */
