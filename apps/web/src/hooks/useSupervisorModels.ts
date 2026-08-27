/**
 * The model catalogue, resolved on demand (#394, epic #391).
 *
 * ## Two different kinds of bad news, kept apart
 *
 * `catalog` carries the API's own finding — no key, a rejected key, a key
 * shaped like the other provider's, a host that never answered. Those are 200s
 * and they are the interesting content of this screen, not errors.
 * `requestError` is the other thing entirely: the request itself did not
 * complete, because the account may not read operator settings or because the
 * API is down. Collapsing the two would let "we could not ask" render as
 * "your key is bad", which is the wrong conclusion to hand somebody holding a
 * working credential.
 *
 * ## A stale list is worse than an empty one
 *
 * A model list belongs to a provider. `refresh` clears the previous catalogue
 * before it asks, so the moment an operator switches provider the old vendor's
 * models stop being offered — rather than lingering, selectable, until the new
 * answer lands. That is #394's requirement stated as a data rule instead of a
 * rendering one, so no component can forget it.
 *
 * ## Read on mount, and only when asked after that
 *
 * Not polled. This is a list beside a dropdown, and a background refresh
 * landing mid-selection buys nothing — so it reads on mount, and again when
 * the operator presses the refresh or saves a provider or a key, which are the
 * moments the answer is known to have changed.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, getSupervisorModelCatalog } from '../services/api';
import type { SupervisorModelCatalog } from '../types/supervisorModels';
import { useIsMounted } from './useIsMounted';

export interface UseSupervisorModelsResult {
  /** The provider's answer, whatever it was. Null before the first one. */
  catalog: SupervisorModelCatalog | null;
  isLoading: boolean;
  /** Why the REQUEST failed. Never a verdict on a credential — see above. */
  requestError: string | null;
  refresh: () => Promise<void>;
}

export function useSupervisorModels(): UseSupervisorModelsResult {
  const [catalog, setCatalog] = useState<SupervisorModelCatalog | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  // Every `setState` past an `await` is guarded: a request settling after the
  // section is gone must not schedule an update on it.
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setRequestError(null);
    // Dropped before the request, not after it. See this file's header.
    setCatalog(null);

    try {
      const data = await getSupervisorModelCatalog();
      if (isMounted()) setCatalog(data);
    } catch (error) {
      if (isMounted()) setRequestError(describe(error));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  // Read on mount. The three writes before the first `await` are all no-ops
  // there — `isLoading` starts true, and the other two start null — so the
  // cascading render the lint rule guards against does not exist here, while
  // deferring them would delay the spinner on every later refresh instead.
  // Same reasoning as `useOperatorSettings` and `useCeilingSpend`.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount, see above
    void refresh();
  }, [refresh]);

  return { catalog, isLoading, requestError, refresh };
}

/**
 * Why the request failed, in the operator's terms.
 *
 * The 403 is called out for the same reason `useOperatorSettings` calls it
 * out: an account can reach this screen and still be refused, and that is a
 * fact about the account rather than about the supervisor's configuration.
 */
function describe(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return (
      'This account may not list the supervisor models, which needs ' +
      'system_settings:read. Nothing here says anything about the key.'
    );
  }

  return error instanceof ApiError
    ? `GET /api/operator-settings/supervisor-models answered ${error.status}: ${error.message}`
    : 'The supervisor model list could not be read.';
}

export default useSupervisorModels;
