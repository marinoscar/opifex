/**
 * The model catalogue, resolved on demand — once per consumer (#423, #394).
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
 * ## One state per consumer, keyed by what the ANSWER says (#423)
 *
 * The supervisor and the chat select a provider independently, so there are
 * two lists on screen at once and they are answers to two different questions.
 * Both requests go out on mount and either may settle first, so a hook that
 * filed each answer under the consumer it had asked for at that index — or,
 * worse, in arrival order — would eventually show the chat the supervisor's
 * models. Every response carries the `consumer` it is for, echoed by the API
 * for exactly this reason, and that echo is what a response is stored under.
 * The requested consumer is only used to clear its pending flag, so a reply
 * that names something else cannot leave a spinner running forever.
 *
 * ## A stale list is worse than an empty one
 *
 * A model list belongs to a provider. `refresh` clears that consumer's
 * previous catalogue before it asks, so the moment an operator switches
 * provider the old vendor's models stop being offered — rather than lingering,
 * selectable, until the new answer lands. That is #394's requirement stated as
 * a data rule instead of a rendering one, so no component can forget it. It
 * clears ONE consumer's list, because the other consumer's answer is still
 * true.
 *
 * ## Read on mount, and only when asked after that
 *
 * Not polled. This is a list beside a dropdown, and a background refresh
 * landing mid-selection buys nothing — so it reads on mount, and again when
 * the operator presses the refresh or saves a provider or a key, which are the
 * moments the answer is known to have changed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, getModelCatalog } from '../services/api';
import type { SupervisorModelCatalog } from '../types/supervisorModels';
import { useIsMounted } from './useIsMounted';

/** What is known about one consumer's list right now. */
export interface ModelCatalogState {
  /** The provider's answer, whatever it was. Null before the first one. */
  catalog: SupervisorModelCatalog | null;
  isLoading: boolean;
  /** Why the REQUEST failed. Never a verdict on a credential — see above. */
  requestError: string | null;
}

/** What a consumer nobody has asked about yet looks like. */
export const UNASKED_CATALOG: ModelCatalogState = {
  catalog: null,
  isLoading: true,
  requestError: null,
};

export interface UseModelCatalogsResult {
  /** One state per consumer, keyed by the consumer the API named. */
  catalogs: Record<string, ModelCatalogState>;
  /** Ask again for one consumer. Drops that consumer's list first. */
  refresh: (consumer: string) => Promise<void>;
  /** Ask again for every consumer given — what a credential write moves. */
  refreshAll: () => Promise<void>;
}

/** One consumer's state, with the not-yet-asked default. */
export function catalogStateFor(
  catalogs: Record<string, ModelCatalogState>,
  consumer: string,
): ModelCatalogState {
  return catalogs[consumer] ?? UNASKED_CATALOG;
}

export function useModelCatalogs(
  consumers: readonly string[],
): UseModelCatalogsResult {
  const [catalogs, setCatalogs] = useState<Record<string, ModelCatalogState>>(
    {},
  );
  // Every `setState` past an `await` is guarded: a request settling after the
  // section is gone must not schedule an update on it.
  const isMounted = useIsMounted();

  // The consumers are DISCOVERED from the settings response, so the array is a
  // fresh object on every render of the caller. Joining it gives the effect
  // below a dependency that changes when the set does and not when the render
  // does — otherwise every render would re-ask both providers.
  const key = consumers.join(',');
  const asked = useMemo(() => (key === '' ? [] : key.split(',')), [key]);

  const refresh = useCallback(
    async (consumer: string) => {
      // Dropped before the request, not after it. See this file's header.
      setCatalogs((previous) => ({
        ...previous,
        [consumer]: { catalog: null, isLoading: true, requestError: null },
      }));

      try {
        const data = await getModelCatalog(consumer);
        if (!isMounted()) return;

        setCatalogs((previous) => ({
          ...previous,
          // The request's own consumer stops loading whatever came back, so a
          // reply that names something else cannot leave a spinner running.
          [consumer]: {
            ...(previous[consumer] ?? UNASKED_CATALOG),
            isLoading: false,
          },
          // …and the ANSWER is filed under the consumer it names. The two
          // assignments are the same key in every real case; when they are
          // not, this one wins, which is the point.
          [data.consumer]: {
            catalog: data,
            isLoading: false,
            requestError: null,
          },
        }));
      } catch (error) {
        if (!isMounted()) return;
        setCatalogs((previous) => ({
          ...previous,
          [consumer]: {
            catalog: null,
            isLoading: false,
            requestError: describe(error),
          },
        }));
      }
    },
    [isMounted],
  );

  const refreshAll = useCallback(async () => {
    await Promise.all(asked.map((consumer) => refresh(consumer)));
  }, [asked, refresh]);

  // Read on mount, and again if the API's set of consumers changes. The set is
  // empty until the settings document lands, so the first render asks nothing
  // and the effect runs again — once — with the consumers the response
  // carried. Same fetch-on-mount shape as `useOperatorSettings` and
  // `useCeilingSpend`.
  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  return { catalogs, refresh, refreshAll };
}

/**
 * Why the request failed, in the operator's terms.
 *
 * The 403 is called out for the same reason `useOperatorSettings` calls it
 * out: an account can reach this screen and still be refused, and that is a
 * fact about the account rather than about the model configuration.
 */
function describe(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return (
      'This account may not list the models, which needs ' +
      'system_settings:read. Nothing here says anything about the key.'
    );
  }

  return error instanceof ApiError
    ? `GET /api/operator-settings/supervisor-models answered ${error.status}: ${error.message}`
    : 'The model list could not be read.';
}

export default useModelCatalogs;
