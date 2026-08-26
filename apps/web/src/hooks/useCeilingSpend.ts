/**
 * Spend against the factory ceiling's own window (#349, epic #332).
 *
 * ## One read model, not a new endpoint
 *
 * `GET /api/cost/summary` already computes this: `ceiling.spend` is tallied
 * over the CEILING's window rather than the window the request asked for
 * (`apps/api/src/cockpit/cost.service.ts`), which is precisely the figure a
 * ceiling has to be shown against. So the `days` sent here does not affect
 * what this section renders, and only `summary.ceiling` is read.
 *
 * ## A refusal is a fact about the ACCOUNT
 *
 * The cost read model enforces `runs:read`, which is a different permission
 * from the `system_settings:read` that opens the Control Center. An operator
 * may hold one without the other, so a 403 is reported as "this account may
 * not read spend" rather than rendered as a window in which nothing was spent.
 * Zero spend and unreadable spend are opposite claims and this screen decides
 * a budget.
 *
 * ## Read once, not polled
 *
 * The cockpit panels poll because they are watching. This is a figure beside
 * an editable field, and a background refresh landing mid-edit buys nothing —
 * so it reads on mount and after a save, which are the two moments it is
 * known to have changed.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, getCostSummary } from '../services/api';
import type { CostSummary } from '../types/cockpit';
import { useIsMounted } from './useIsMounted';

/** The window asked for. Immaterial to `ceiling` — see the header. */
const WINDOW_DAYS = 30;

export interface CeilingSpendProblem {
  /** `forbidden` is about the account; `failed` is about the request. */
  kind: 'forbidden' | 'failed';
  detail: string;
}

export interface UseCeilingSpendResult {
  summary: CostSummary | null;
  isLoading: boolean;
  problem: CeilingSpendProblem | null;
  refresh: () => Promise<void>;
}

export function useCeilingSpend(): UseCeilingSpendResult {
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [problem, setProblem] = useState<CeilingSpendProblem | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setProblem(null);

    try {
      const data = await getCostSummary(WINDOW_DAYS);
      if (isMounted()) setSummary(data);
    } catch (error) {
      if (!isMounted()) return;
      // The previous figure is dropped rather than kept: unlike a polled
      // panel, this one has no header saying "stale since", and a budget
      // figure shown beside an error with no age on it is worse than none.
      setSummary(null);
      setProblem(describe(error));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  // Read on mount. Both writes before the first `await` are no-ops there —
  // `isLoading` starts true and `problem` starts null — so the rule's
  // cascading render does not exist; same reasoning as `useOperatorSettings`.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount, see above
    void refresh();
  }, [refresh]);

  return { summary, isLoading, problem, refresh };
}

function describe(error: unknown): CeilingSpendProblem {
  if (error instanceof ApiError && error.status === 403) {
    return {
      kind: 'forbidden',
      detail:
        'This account may not read the cost read model, which needs ' +
        'runs:read — a different permission from the one that opens this ' +
        'screen. Nothing here says how much has been spent.',
    };
  }

  return {
    kind: 'failed',
    detail:
      error instanceof ApiError
        ? `GET /api/cost/summary answered ${error.status}: ${error.message}`
        : 'GET /api/cost/summary could not be read.',
  };
}

export default useCeilingSpend;
