/**
 * The approval queue and one approval, polled (#98, epic #22).
 *
 * Both read hooks are `usePolledResource` like every other cockpit resource,
 * so they inherit its five load-bearing behaviours — in particular that a
 * failed poll never blanks what is on screen, and that polling pauses while
 * the tab is hidden. Two of them matter more here than anywhere else in the
 * app: an operator reading an approval on a phone must not have the reasoning
 * yanked out from under them by one flaky request, and the detail screen is
 * frequently the thing left open on a locked phone.
 *
 * `enabled` is `true` unconditionally rather than read from
 * `config/cockpitApi.ts`: these endpoints exist. That registry exists to
 * express "not built yet", and there is nothing to express.
 */

import { useCallback } from 'react';
import { COCKPIT_POLL_INTERVAL_MS } from '../config/cockpitApi';
import { getApprovals, getApproval } from '../services/api';
import type {
  Approval,
  ApprovalDetail,
  OpenApprovalStatus,
} from '../types/approvals';
import { usePolledResource } from './usePolledResource';
import type { UsePolledResourceResult } from './usePolledResource';

export interface ApprovalQueueFilters {
  status?: OpenApprovalStatus;
  repositoryId?: string;
}

/**
 * Everything still waiting on a person, OLDEST FIRST.
 *
 * The order is the server's and is passed through untouched. Sorting it
 * newest-first — the reflex for a list of things that arrived — would bury the
 * request that has been ignored longest, which is the single fact this queue
 * exists to surface.
 */
export function useApprovalQueue(
  filters: ApprovalQueueFilters = {},
): UsePolledResourceResult<Approval[]> {
  const { status, repositoryId } = filters;

  // Primitive dependencies rather than the object: a caller passing an inline
  // `{}` would otherwise rebuild the fetcher every render.
  const fetcher = useCallback(
    (signal: AbortSignal) =>
      getApprovals(
        {
          ...(status ? { status } : {}),
          ...(repositoryId ? { repositoryId } : {}),
        },
        signal,
      ),
    [status, repositoryId],
  );

  return usePolledResource<Approval[]>({
    fetcher,
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    enabled: true,
  });
}

/** One approval, with its ADR-0011 registry entry joined on by the API. */
export function useApproval(
  id: string,
): UsePolledResourceResult<ApprovalDetail> {
  const fetcher = useCallback(
    (signal: AbortSignal) => getApproval(id, signal),
    [id],
  );

  return usePolledResource<ApprovalDetail>({
    fetcher,
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    // An id that has not arrived yet must not fire a request for `/approvals/`.
    enabled: Boolean(id),
  });
}
