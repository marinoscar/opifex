/**
 * The Control Center's repository read and write (#350, epic #332).
 *
 * Reads `GET /repositories` once, writes through `PATCH /repositories/:id`,
 * and runs the per-repository access probe on demand.
 *
 * ## Not polled, unlike every other cockpit read
 *
 * `usePolledResource` feeds the read-only surfaces, and this one is not read
 * only. A poll landing mid-edit would replace the `repositories` array under
 * an operator who has three switches drafted and has not pressed Save, and the
 * card re-seeds its draft when a new repository object arrives (the same
 * render-time reseed `InterfaceSection` uses) — so a background refresh would
 * silently discard their work. The list is re-read after a save instead,
 * which is the only moment it is known to have changed.
 *
 * ## Probe results are per repository and never inferred
 *
 * `probes` is keyed by repository id and holds only what a probe actually
 * answered. A repository with no entry has not been tested, which is a third
 * state and renders as one — not as a pass and not as a failure.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  getRepositories,
  probeRepositoryAccess,
  updateRepository,
  type RepositoryAccessProbeResult,
  type UpdateRepositoryInput,
} from '../services/api';
import type { RepositorySummary } from '../types/cockpit';
import { useIsMounted } from './useIsMounted';

/**
 * One page, sized past any plausible registration count for a single
 * deployment. Paging the ladder would mean an operator could enable dispatch
 * on page 1 and not see that page 2 exists — and the endpoint caps `pageSize`
 * at 100, so this is the largest single answer it will give.
 */
const PAGE_SIZE = 100;

export interface UseRepositoryLadderResult {
  repositories: RepositorySummary[];
  /** How many are registered in total, so a truncated list can say so. */
  total: number;
  isLoading: boolean;
  /** Why the list could not be read, if it could not. */
  error: string | null;
  /** The repository currently being written, if any. */
  savingId: string | null;
  /** The repository currently being probed, if any. */
  probingId: string | null;
  /** What a probe answered, per repository. Absent means never tested. */
  probes: Record<string, RepositoryAccessProbeResult>;
  refresh: () => Promise<void>;
  /** Throws on failure, so the caller can show the API's own refusal. */
  save: (id: string, input: UpdateRepositoryInput) => Promise<void>;
  testAccess: (id: string) => Promise<void>;
  /**
   * Take in a repository `POST /repositories` just created (#401).
   *
   * Not a `refresh`, deliberately. A re-read sets `isLoading`, and the section
   * renders a spinner in place of everything while it is true — including the
   * picker dialog the operator is still standing in, which would be unmounted
   * mid-flow by the very registration that succeeded.
   *
   * Not optimistic either: the argument is the row the API RETURNED, so what
   * lands in the list is the API's account of the registration rather than the
   * request that asked for it. Inserted in the API's own order (owner, then
   * name) so the list looks the same as it will after the next real read, and
   * idempotent by id so a double delivery cannot duplicate a row.
   */
  adopt: (repository: RepositorySummary) => void;
}

export function useRepositoryLadder(): UseRepositoryLadderResult {
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [probes, setProbes] = useState<
    Record<string, RepositoryAccessProbeResult>
  >({});
  // Every `setState` past an `await` is guarded — a request settling after the
  // section is closed must not schedule an update on a gone component.
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const page = await getRepositories({ page: 1, pageSize: PAGE_SIZE });
      if (isMounted()) {
        setRepositories(page.items);
        setTotal(page.total);
      }
    } catch (err) {
      if (isMounted()) {
        setError(
          err instanceof Error
            ? err.message
            : 'The repository list could not be read.',
        );
        setRepositories([]);
        setTotal(0);
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  // Load on mount. `refresh` sets `isLoading` and clears `error` before its
  // first `await`, which the rule reads as a synchronous setState in an
  // effect; on mount both are already those values, so there is no cascading
  // render to remove — the same reasoning `useSystemSettings` records.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount, see above
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (id: string, input: UpdateRepositoryInput) => {
      setSavingId(id);
      try {
        const updated = await updateRepository(id, input);
        // Replace the row with what the API RETURNED rather than with the
        // draft that was sent. Enabling dispatch re-verifies reachability
        // server-side and the response is the only account of what actually
        // took — assuming the draft landed is the optimistic lie epic #332
        // exists to stop.
        if (isMounted()) {
          setRepositories((current) =>
            current.map((repo) => (repo.id === id ? updated : repo)),
          );
        }
      } finally {
        if (isMounted()) setSavingId(null);
      }
    },
    [isMounted],
  );

  const testAccess = useCallback(
    async (id: string) => {
      setProbingId(id);
      try {
        // Resolves for every outcome, including "the endpoint does not exist
        // yet" — see `probeRepositoryAccess`.
        const result = await probeRepositoryAccess(id);
        if (isMounted()) {
          setProbes((current) => ({ ...current, [id]: result }));
        }
      } finally {
        if (isMounted()) setProbingId(null);
      }
    },
    [isMounted],
  );

  const adopt = useCallback(
    (repository: RepositorySummary) => {
      // The guard is outside the updater on purpose: `total` has to move with
      // the array or the section reports "showing 3 of 4" for a list of three.
      // Two separate updaters cannot agree on whether a row was new.
      if (repositories.some((row) => row.id === repository.id)) return;

      setRepositories((current) =>
        [...current, repository].sort(byOwnerThenName),
      );
      setTotal((current) => current + 1);
    },
    [repositories],
  );

  return {
    repositories,
    total,
    isLoading,
    error,
    savingId,
    probingId,
    probes,
    refresh,
    save,
    testAccess,
    adopt,
  };
}

/** The API's `orderBy: [{ owner: 'asc' }, { name: 'asc' }]`, restated. */
function byOwnerThenName(
  left: RepositorySummary,
  right: RepositorySummary,
): number {
  return (
    left.owner.localeCompare(right.owner) || left.name.localeCompare(right.name)
  );
}

export default useRepositoryLadder;
