/**
 * What the steering scope picker may offer (#460, epic #457).
 *
 * ## Two reads, and why not three
 *
 * `GET /projects` for the groups, `GET /repositories?observeEnabled=true&retired=false`
 * for what steering calls REGISTERED — `registeredRepositories()`'s own filter,
 * matched exactly so no option in the picker can come back
 * `repository-not-registered`.
 *
 * The unassigned bucket is derived from `projectId` on those same rows rather
 * than asked for with a third `?projectId=none` request. The endpoint carries
 * `projectId` per row, so one pass answers every project AND the bucket; the
 * filtered form would be one request per project for the same answer, and
 * there is deliberately no `GET /projects/{id}/repositories` to make it fewer
 * (`types/projects.ts`).
 *
 * ## Every page, not the first one
 *
 * Both lists are read to completion — `pageSize` is capped at 100 by both
 * schemas, so a deployment with 140 observed repositories would otherwise be
 * offered 100 of them with no sign that 40 were missing. A picker that
 * silently omits a repository is the mis-scoping this issue exists to remove,
 * arrived at from the other direction: the operator would fall back to the
 * thing they can no longer type. The loop is SEQUENTIAL for the reason
 * `useAvailableRepositories.registerMany` gives — parallelism multiplies the
 * burst rate against a shared budget for no wall-clock benefit worth having —
 * and bounded, with `truncated` said out loud rather than hidden if the bound
 * is ever reached.
 *
 * ## Not polled
 *
 * A registered repository set changes when somebody registers a repository,
 * which is a different screen. A background refresh landing mid-selection
 * would buy nothing and could move the option under the operator's cursor.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, getProjects, getRepositories } from '../services/api';
import {
  buildScopeCatalogue,
  type ScopeCatalogue,
} from '../config/steeringScope';
import type { RepositorySummary } from '../types/cockpit';
import type { Project } from '../types/projects';
import { useIsMounted } from './useIsMounted';

/** The cap both list schemas enforce (`max(100)`). Asking for more is a 400. */
const PAGE_SIZE = 100;

/** 1000 repositories or projects. Past that the picker says so. */
const MAX_PAGES = 10;

export interface UseSteeringScopesResult {
  /** The scopes on offer, plus the single-repository shortcut. */
  catalogue: ScopeCatalogue;
  isLoading: boolean;
  /** Why the lists could not be read, if they could not. */
  error: string | null;
  /** A list ran past `MAX_PAGES` and is incomplete. Said, never hidden. */
  truncated: boolean;
  refresh: () => Promise<void>;
}

/** Read one paginated list to the end, or to the page cap. */
async function readAll<T>(
  fetchPage: (page: number) => Promise<{ items: T[]; total: number }>,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let page = 1;
  let total = 0;

  do {
    const answer = await fetchPage(page);
    total = answer.total;
    items.push(...answer.items);
    if (answer.items.length === 0) break;
    page += 1;
  } while (items.length < total && page <= MAX_PAGES);

  return { items, truncated: items.length < total };
}

export function useSteeringScopes(): UseSteeringScopesResult {
  const [projects, setProjects] = useState<Project[]>([]);
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  // Every `setState` past an `await` is guarded: an answer landing after the
  // operator has navigated away must not update a gone component.
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const registered = await readAll((page) =>
        getRepositories({
          page,
          pageSize: PAGE_SIZE,
          // `registeredRepositories()`'s filter, field for field. Anything
          // wider would offer a scope the API answers 404 to.
          observeEnabled: true,
          retired: false,
        }),
      );
      const groups = await readAll((page) =>
        getProjects({ page, pageSize: PAGE_SIZE }),
      );

      if (!isMounted()) return;
      setRepositories(registered.items);
      setProjects(groups.items);
      setTruncated(registered.truncated || groups.truncated);
    } catch (cause) {
      if (!isMounted()) return;
      setError(describe(cause));
      // Dropped rather than left standing: a half-read list under a failed
      // refresh is an answer about a different moment presented as this one,
      // and here it would be a picker missing exactly the scope somebody
      // needed.
      setRepositories([]);
      setProjects([]);
      setTruncated(false);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  // Reads once, on mount. See the header for why it is not polled.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount, see above
    void refresh();
  }, [refresh]);

  const catalogue = useMemo(
    () => buildScopeCatalogue(projects, repositories),
    [projects, repositories],
  );

  return { catalogue, isLoading, error, truncated, refresh };
}

/**
 * Why the lists could not be read, in the operator's terms.
 *
 * The 403 is called out because it is not a fault and it is REACHABLE: both
 * `GET /repositories` and `GET /projects` are gated on `projects:read`, while
 * steering is gated on `workorders:write` — deliberately, since it is the one
 * Operate destination on a write permission (`destinations.ts`). A role
 * holding one and not the other can therefore steer perfectly well and still
 * be refused this list, and reporting that as a broken screen would send an
 * operator looking for a fault that is not there.
 */
function describe(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return (
      'This account may steer but may not list the repositories and projects ' +
      'to scope by, which needs projects:read.'
    );
  }

  return error instanceof ApiError
    ? `The repositories and projects steering can reach could not be read: ${error.message}`
    : 'The repositories and projects steering can reach could not be read.';
}

export default useSteeringScopes;
