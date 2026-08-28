/**
 * What the configured GitHub credential can reach, and the write that follows
 * (#401).
 *
 * ## Two different kinds of bad news, kept apart
 *
 * `listing` carries the API's own finding — no credential, a rejected one, a
 * refused one, an exhausted rate limit, a GitHub that never answered. Those
 * are 200s and they are the interesting content of this dialog, not errors.
 * `requestError` is the other thing entirely: the request itself did not
 * complete, because the account may not hold `projects:read` or because the
 * API is down. Collapsing the two would let "we could not ask" render as
 * "your token is bad", which is the wrong conclusion to hand somebody holding
 * a working credential. The same rule `useModelCatalogs` states.
 *
 * ## Search and paging are the API's, not this file's
 *
 * `search` filters the whole reachable set server-side and `page` slices what
 * is left, so both are sent and neither is re-implemented here. Filtering a
 * page client-side would search 25 rows and call it a search over the token's
 * scope, which is the kind of quiet lie the endpoint was built to avoid.
 *
 * ## The answered page is the one that is true
 *
 * A consumer renders `listing.page`, `listing.search` and `listing.total` —
 * what the API actually answered — rather than the requested values held here.
 * While a page is in flight the two differ, and only one of them is a fact.
 *
 * ## Several registrations are N requests, ISSUED ONE AT A TIME (#407)
 *
 * `POST /api/repositories` takes one repository, and `registerMany` below
 * loops it rather than reaching for a batch endpoint. The choice is argued on
 * `registerMany` itself; the part that belongs here is that the loop is
 * **sequential**, for the reason `reconciler.service.ts` gives for its own
 * sweep: parallelism multiplies the burst rate against a shared GitHub budget
 * (VISION §11) for no wall-clock benefit worth having, and every registration
 * spends from the same budget `github.rateLimitReserve` holds back so an
 * operator's interactive use keeps working. Thirty registrations fired at once
 * is the shape that trips a secondary rate limit.
 *
 * ## Read when the dialog opens, and only when asked after that
 *
 * Not polled. This is a list beside a picker, and a background refresh landing
 * mid-selection buys nothing — so it reads on mount, and again when the
 * operator searches, pages, presses refresh, or registers something, which are
 * the moments the answer is known to have changed.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  createRepository,
  getAvailableRepositories,
} from '../services/api';
import type { RegistrationResult } from '../config/availableRepositories';
import type {
  AvailableRepositories,
  AvailableRepository,
} from '../types/repositories';
import { useIsMounted } from './useIsMounted';

/** The API's own default, stated so the page summary and the request agree. */
const PAGE_SIZE = 25;

export interface UseAvailableRepositoriesResult {
  /** The API's answer, whatever it was. Null before the first one. */
  listing: AvailableRepositories | null;
  isLoading: boolean;
  /** Why the REQUEST failed. Never a verdict on the credential — see above. */
  requestError: string | null;
  /** The page being asked for. `listing.page` is the one that was answered. */
  page: number;
  /** The search being asked for. `listing.search` is the one that was applied. */
  search: string;
  /** Ask for a page. Resets nothing else. */
  goToPage: (page: number) => void;
  /** Apply a search, which starts again at page 1 — page 4 of the old set is
   * not page 4 of the new one. */
  applySearch: (search: string) => void;
  refresh: () => Promise<void>;
  /**
   * How far a batch has got, or null when none is running.
   *
   * Published because the registrations are sequential and a selection of
   * thirty is a real wait: an unmoving spinner and a progressing count are the
   * same duration and not the same experience, and the count is the only
   * honest way to say which repository the wait is currently on.
   */
  progress: RegistrationProgress | null;
  /**
   * Register repositories, in order, optionally filed into a project.
   *
   * ## Why N requests and not a batch endpoint
   *
   * `POST /repositories` verifies per repository that it is reachable with the
   * configured credential, and answers 400, 409 and 503 for the three ways one
   * can be refused. A batch endpoint would be new API surface that has to
   * decide its own partial-failure semantics ANYWAY — a batch of eight where
   * two are already registered cannot answer one status honestly — so it would
   * relocate this problem rather than remove it, and it would do so by
   * duplicating refusal semantics that already work. The one thing it could
   * add that N requests cannot is a transaction, and a transaction is the
   * outcome this feature explicitly does not want: rolling back six good
   * registrations because the seventh was archived throws away exactly what
   * the operator asked for.
   *
   * ## Why it never rejects
   *
   * Resolves with one `RegistrationResult` per repository, in the order they
   * were attempted, and does not reject: a refusal partway through is an
   * ordinary outcome of a batch and not a failure of it, and throwing would
   * discard the answers for the repositories that had already succeeded. The
   * loop therefore runs to the end rather than stopping at the first refusal,
   * so what an operator gets back does not depend on the order the rows
   * happened to be in.
   *
   * `projectId` is passed on each CREATE rather than followed by an assignment
   * call: two requests would leave a window in which the repository exists and
   * is in no project, and a failure in the second would strand it there
   * looking like an unassigned registration nobody made.
   */
  registerMany: (
    repositories: readonly AvailableRepository[],
    projectId?: string,
  ) => Promise<RegistrationResult[]>;
}

/** Which repository a running batch is on, and how many are done. */
export interface RegistrationProgress {
  /** Registrations that have ANSWERED — refusals included, since a refusal is
   * an answer and the batch has moved past it. */
  done: number;
  total: number;
  /** The one in flight. */
  current: string;
}

export function useAvailableRepositories(): UseAvailableRepositoriesResult {
  const [listing, setListing] = useState<AvailableRepositories | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [progress, setProgress] = useState<RegistrationProgress | null>(null);
  // Every `setState` past an `await` is guarded: a request settling after the
  // dialog is closed must not schedule an update on a gone component.
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setRequestError(null);

    try {
      const answer = await getAvailableRepositories({
        page,
        pageSize: PAGE_SIZE,
        search,
      });
      if (isMounted()) setListing(answer);
    } catch (error) {
      if (isMounted()) {
        setRequestError(describe(error));
        // Dropped, because a listing left on screen under a failed refresh
        // would be an answer about a different moment presented as this one.
        setListing(null);
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted, page, search]);

  // Reads on mount and again whenever the requested page or search changes —
  // `refresh` closes over both, so its identity is the dependency. The two
  // writes before the first `await` are no-ops on mount (`isLoading` starts
  // true and `requestError` starts null), and on a later page they are the
  // spinner the operator is owed; deferring them would delay it instead. Same
  // reasoning as `useModelCatalogs` and `useRepositoryLadder`.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount and on page/search change, see above
    void refresh();
  }, [refresh]);

  const goToPage = useCallback((next: number) => {
    setPage(next);
  }, []);

  const applySearch = useCallback((next: string) => {
    setSearch(next);
    // Page 4 of the old result set is not page 4 of the new one, and asking
    // for it would answer an empty page that reads like "nothing matched".
    setPage(1);
  }, []);

  const registerMany = useCallback(
    async (
      repositories: readonly AvailableRepository[],
      projectId?: string,
    ) => {
      const results: RegistrationResult[] = [];

      try {
        for (const repository of repositories) {
          if (isMounted()) {
            setProgress({
              done: results.length,
              total: repositories.length,
              current: repository.fullName,
            });
          }

          try {
            // The two identifying fields, plus the project when there is one.
            // No policy flag is sent: every default lives in the Prisma
            // schema, so what lands is observed and never dispatched — see
            // `CreateRepositoryInput`.
            const created = await createRepository({
              owner: repository.owner,
              name: repository.name,
              ...(projectId !== undefined && { projectId }),
            });
            results.push({
              fullName: repository.fullName,
              refusal: null,
              repository: created,
            });
          } catch (error) {
            // Caught per repository and never rethrown. The next repository is
            // still attempted, because one archived row is a fact about that
            // row and says nothing about the seven behind it.
            results.push({
              fullName: repository.fullName,
              repository: null,
              refusal: {
                status: error instanceof ApiError ? error.status : null,
                detail:
                  error instanceof Error
                    ? error.message
                    : 'The API gave no reason for the refusal.',
              },
            });
          }
        }
      } finally {
        if (isMounted()) setProgress(null);
      }

      return results;
    },
    [isMounted],
  );

  return {
    listing,
    isLoading,
    requestError,
    page,
    search,
    goToPage,
    applySearch,
    refresh,
    progress,
    registerMany,
  };
}

/**
 * Why the REQUEST failed, in the operator's terms.
 *
 * The 403 is called out for the same reason `useOperatorSettings` calls it
 * out: an account can reach the Projects screen and still be refused this list,
 * and that is a fact about the account rather than about the credential.
 */
function describe(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return (
      'This account may not list the repositories the credential can reach, ' +
      'which needs projects:read. Nothing here says anything about the ' +
      'GitHub token.'
    );
  }

  return error instanceof ApiError
    ? `GET /api/repositories/available answered ${error.status}: ${error.message}`
    : 'The list of reachable repositories could not be read.';
}

export default useAvailableRepositories;
