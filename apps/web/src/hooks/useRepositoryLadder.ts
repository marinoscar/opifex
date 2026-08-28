/**
 * The repositories of one scope, and every write `/projects` makes to them
 * (#350 for the ladder, #405 for retirement, #406 for the move).
 *
 * Reads `GET /repositories?projectId=…`, writes through
 * `PATCH /repositories/:id`, retires and un-retires through the two action
 * endpoints, de-registers through `DELETE /repositories/:id`, and runs the
 * per-repository access probe on demand.
 *
 * ## Scoped, and `none` is a scope like any other
 *
 * The scope is a project id or the unassigned bucket, and both are ONE query
 * parameter rather than a filter plus a flag — `projectId=none` is the API's
 * own spelling. Every repository registered before projects existed is in that
 * bucket, so it has to be as reachable as any project or the screen would
 * strand every registration that predates it.
 *
 * ## Not polled, unlike every other cockpit read
 *
 * `usePolledResource` feeds the read-only surfaces, and this one is not read
 * only. A poll landing mid-edit would replace the `repositories` array under
 * an operator who has three switches drafted and has not pressed Save, and the
 * card re-seeds its draft when a new repository object arrives — so a
 * background refresh would silently discard their work. The list is re-read
 * when the scope changes and after a write, which are the moments it is known
 * to have changed.
 *
 * ## A stale answer is dropped, not rendered
 *
 * Switching scope twice quickly can land the first answer after the second.
 * Each read carries a sequence number and only the latest one is allowed to
 * write state — otherwise the panel would show one project's repositories
 * under another project's heading, which is the one mistake this screen must
 * not make.
 *
 * ## Probe results are per repository and never inferred
 *
 * `probes` is keyed by repository id and holds only what a probe actually
 * answered. A repository with no entry has not been tested, which is a third
 * state and renders as one — not as a pass and not as a failure.
 *
 * ## Label reports are observations, asked for rather than polled (#415)
 *
 * `labelReports` follows `probes` exactly, and for the same reasons. Each
 * entry costs a GitHub request, so reading them for every row on every load of
 * this panel would spend the shared rate-limit budget (VISION §11) on a
 * question nobody asked — the access Test beside it made the same choice. A
 * repository with no entry has not been LOOKED AT, which is a third state and
 * renders as one.
 *
 * The exception is a registration: `POST /repositories` provisions the labels
 * and returns the report, so `adopt` seeds it. That report is an observation
 * taken a moment ago rather than an inference, which is exactly what the row
 * renders — with its own `checkedAt`, going stale like any other.
 *
 * `labelErrors` is kept apart from `labelReports` because a GitHub failure is
 * a 200 carrying a `status` while an `ApiError` means the REQUEST failed. The
 * rule `useAvailableRepositories` states: collapsing the two would let "we
 * could not ask" render as "your token is bad".
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ApiError,
  deleteRepository,
  getRepositories,
  getRepositoryLabels,
  probeRepositoryAccess,
  repairRepositoryLabels,
  retireRepository,
  unretireRepository,
  updateRepository,
  type RegisteredRepository,
  type RepositoryAccessProbeResult,
  type UpdateRepositoryInput,
} from '../services/api';
import type { RepositorySummary } from '../types/cockpit';
import type { LabelProvisioningReport } from '../types/repositoryLabels';
import { scopeQueryValue, type ProjectScope } from '../types/projects';
import { useIsMounted } from './useIsMounted';

/**
 * One page, sized past any plausible registration count for a single project.
 * Paging the ladder would mean an operator could enable dispatch on page 1 and
 * not see that page 2 exists — and the endpoint caps `pageSize` at 100, so
 * this is the largest single answer it will give.
 */
const PAGE_SIZE = 100;

export interface UseRepositoryLadderResult {
  repositories: RepositorySummary[];
  /** How many are in this scope in total, so a truncated list can say so. */
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
  /**
   * What GitHub had, per repository, when somebody last looked (#415).
   *
   * Absent means nobody has looked — never "no labels". A report whose
   * `status` is a GitHub-level failure carries an EMPTY `labels` array and a
   * `present` of zero, which also does not mean "no labels";
   * `config/repositoryLabels.ts` is what keeps those apart.
   */
  labelReports: Record<string, LabelProvisioningReport>;
  /** Why the label REQUEST failed, per repository. Never a GitHub verdict. */
  labelErrors: Record<string, string>;
  /** The repository whose labels are being read, if any. */
  checkingLabelsId: string | null;
  /** The repository whose labels are being written, if any. */
  repairingLabelsId: string | null;
  /** Observe the labels. Writes nothing. Never rejects — see `testAccess`. */
  checkLabels: (id: string) => Promise<void>;
  /** Create the missing labels. Never rejects; the report is the answer. */
  repairLabels: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  /** Throws on failure, so the caller can show the API's own refusal. */
  save: (id: string, input: UpdateRepositoryInput) => Promise<void>;
  testAccess: (id: string) => Promise<void>;
  /**
   * Stand a repository down, keeping its runs (#405). Throws on failure.
   *
   * The row STAYS in the list — retired repositories are still listed, because
   * hiding one would leave an operator unable to find the thing they just
   * retired in order to un-retire it.
   */
  retire: (id: string, reason?: string) => Promise<void>;
  /** Put it back at the bottom of the ladder. Throws on failure. */
  unretire: (id: string, reason?: string) => Promise<void>;
  /**
   * De-register it entirely. Throws on failure — including the 400 the API
   * answers while the repository has work orders.
   *
   * The row is dropped only after the API confirms, never optimistically.
   */
  remove: (id: string) => Promise<void>;
  /**
   * Take a repository out of this scope's list without deleting anything.
   *
   * What a successful move to another project, or out of one, leaves behind:
   * the repository still exists, it is simply no longer here.
   */
  evict: (id: string) => void;
  /**
   * Take in a repository `POST /repositories` just created (#401).
   *
   * Not a `refresh`, deliberately. A re-read sets `isLoading`, and the panel
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
  adopt: (repository: RegisteredRepository) => void;
}

export function useRepositoryLadder(
  scope: ProjectScope,
): UseRepositoryLadderResult {
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [probes, setProbes] = useState<
    Record<string, RepositoryAccessProbeResult>
  >({});
  const [labelReports, setLabelReports] = useState<
    Record<string, LabelProvisioningReport>
  >({});
  const [labelErrors, setLabelErrors] = useState<Record<string, string>>({});
  const [checkingLabelsId, setCheckingLabelsId] = useState<string | null>(null);
  const [repairingLabelsId, setRepairingLabelsId] = useState<string | null>(
    null,
  );
  // Every `setState` past an `await` is guarded — a request settling after the
  // page is closed must not schedule an update on a gone component.
  const isMounted = useIsMounted();
  // Which read is the current one. See the header: an answer for a scope the
  // operator has already left must not be painted under the new heading.
  const readSequence = useRef(0);

  const query = scopeQueryValue(scope);

  const refresh = useCallback(async () => {
    const sequence = ++readSequence.current;
    setIsLoading(true);
    setError(null);
    try {
      const page = await getRepositories({
        page: 1,
        pageSize: PAGE_SIZE,
        projectId: query,
      });
      if (isMounted() && sequence === readSequence.current) {
        setRepositories(page.items);
        setTotal(page.total);
      }
    } catch (err) {
      if (isMounted() && sequence === readSequence.current) {
        setError(
          err instanceof Error
            ? err.message
            : 'The repository list could not be read.',
        );
        setRepositories([]);
        setTotal(0);
      }
    } finally {
      if (isMounted() && sequence === readSequence.current) {
        setIsLoading(false);
      }
    }
  }, [isMounted, query]);

  // Load on mount and again whenever the scope changes — `refresh` closes over
  // the scope query, so its identity is the dependency. The two writes before
  // the first `await` are no-ops on mount (`isLoading` starts true and `error`
  // starts null), and on a scope change they are the spinner the operator is
  // owed; deferring them would delay it instead. The same reasoning
  // `useSystemSettings` and `useAvailableRepositories` record.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount and on scope change, see above
    void refresh();
  }, [refresh]);

  /** Replace one row with what the API RETURNED, never with what was sent. */
  const absorb = useCallback(
    (updated: RepositorySummary) => {
      if (isMounted()) {
        setRepositories((current) =>
          current.map((repo) => (repo.id === updated.id ? updated : repo)),
        );
      }
    },
    [isMounted],
  );

  const save = useCallback(
    async (id: string, input: UpdateRepositoryInput) => {
      setSavingId(id);
      try {
        // Enabling dispatch re-verifies reachability server-side and the
        // response is the only account of what actually took — assuming the
        // draft landed is the optimistic lie epic #332 exists to stop.
        absorb(await updateRepository(id, input));
      } finally {
        if (isMounted()) setSavingId(null);
      }
    },
    [absorb, isMounted],
  );

  const retire = useCallback(
    async (id: string, reason?: string) => {
      setSavingId(id);
      try {
        absorb(await retireRepository(id, reason));
      } finally {
        if (isMounted()) setSavingId(null);
      }
    },
    [absorb, isMounted],
  );

  const unretire = useCallback(
    async (id: string, reason?: string) => {
      setSavingId(id);
      try {
        absorb(await unretireRepository(id, reason));
      } finally {
        if (isMounted()) setSavingId(null);
      }
    },
    [absorb, isMounted],
  );

  const evict = useCallback(
    (id: string) => {
      if (!isMounted()) return;
      // The membership test is outside the updaters, as it is in `adopt` and
      // for the same reason: `total` has to move with the array or the panel
      // reports "showing 3 of 4" for a list of three, and two updaters cannot
      // agree on whether a row was really there. A setState nested inside
      // another updater would also run twice under StrictMode.
      if (!repositories.some((repo) => repo.id === id)) return;

      setRepositories((current) => current.filter((repo) => repo.id !== id));
      setTotal((count) => Math.max(0, count - 1));
    },
    [isMounted, repositories],
  );

  const remove = useCallback(
    async (id: string) => {
      setSavingId(id);
      try {
        // Awaited before the row is dropped. `DELETE` is refused with a 400
        // while the repository has work orders, and a row removed optimistically
        // would report a de-registration the API declined.
        await deleteRepository(id);
        evict(id);
      } finally {
        if (isMounted()) setSavingId(null);
      }
    },
    [evict, isMounted],
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

  /**
   * Take in one label report, and drop any request error beside it.
   *
   * The two are mutually exclusive by construction: a report means the request
   * completed, and an error means it did not. Leaving a stale error under a
   * fresh report would report a failure that has since been answered.
   */
  const absorbLabels = useCallback(
    (id: string, report: LabelProvisioningReport) => {
      if (!isMounted()) return;
      setLabelReports((current) => ({ ...current, [id]: report }));
      setLabelErrors((current) => {
        if (!(id in current)) return current;
        const { [id]: _dropped, ...rest } = current;
        return rest;
      });
    },
    [isMounted],
  );

  /**
   * Why the label REQUEST failed. Never a verdict on GitHub or on the token —
   * those arrive as 200s carrying a `status`.
   */
  const absorbLabelError = useCallback(
    (id: string, error: unknown) => {
      if (!isMounted()) return;
      setLabelErrors((current) => ({
        ...current,
        [id]: describeLabelFailure(error),
      }));
    },
    [isMounted],
  );

  const checkLabels = useCallback(
    async (id: string) => {
      setCheckingLabelsId(id);
      try {
        absorbLabels(id, await getRepositoryLabels(id));
      } catch (error) {
        // Not rethrown: the card has a place to render this, and a rejection
        // here would be an unhandled one at every call site.
        absorbLabelError(id, error);
      } finally {
        if (isMounted()) setCheckingLabelsId(null);
      }
    },
    [absorbLabelError, absorbLabels, isMounted],
  );

  const repairLabels = useCallback(
    async (id: string) => {
      setRepairingLabelsId(id);
      try {
        // The answer REPLACES the observation, because it is a newer one: it
        // was taken after the writes, so it is the only account of what is on
        // GitHub now. A refusal is a 200 and lands here too.
        absorbLabels(id, await repairRepositoryLabels(id));
      } catch (error) {
        absorbLabelError(id, error);
      } finally {
        if (isMounted()) setRepairingLabelsId(null);
      }
    },
    [absorbLabelError, absorbLabels, isMounted],
  );

  const adopt = useCallback(
    (repository: RegisteredRepository) => {
      // The guard is outside the updater on purpose: `total` has to move with
      // the array or the panel reports "showing 3 of 4" for a list of three.
      // Two separate updaters cannot agree on whether a row was new.
      if (repositories.some((row) => row.id === repository.id)) return;

      setRepositories((current) =>
        [...current, repository].sort(byOwnerThenName),
      );
      setTotal((current) => current + 1);

      // Registration provisions the labels and reports what happened, so the
      // new row arrives with an observation already taken (#415) rather than
      // asking the operator to press Check on something checked a second ago.
      // Null means provisioning gave no account of itself and undefined means
      // an API from before #415 published no such field; neither is an
      // observation, and neither may be stored as one.
      const report = repository.labelProvisioning;
      if (report !== null && report !== undefined) {
        setLabelReports((current) => ({ ...current, [repository.id]: report }));
      }
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
    labelReports,
    labelErrors,
    checkingLabelsId,
    repairingLabelsId,
    checkLabels,
    repairLabels,
    refresh,
    save,
    testAccess,
    retire,
    unretire,
    remove,
    evict,
    adopt,
  };
}

/**
 * Why the label REQUEST failed, in the operator's terms.
 *
 * Every one of these is a fact about this API call — never about GitHub and
 * never about the token, since a GitHub failure arrives as a 200 with a
 * `status` and is rendered from the report instead.
 */
function describeLabelFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return (
        'This account may not do that to a repository’s labels — reading ' +
        'them needs projects:read and creating them needs projects:write. ' +
        'That is a fact about the account, not about GitHub or the labels.'
      );
    }
    if (error.status === 404) {
      return (
        'The API does not know this repository id. It may have been ' +
        'de-registered in another tab — reload the list.'
      );
    }
    return `The API answered ${error.status}: ${error.message}`;
  }
  return 'The label check could not be made. Nothing was written.';
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
