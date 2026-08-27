/**
 * The project list, and the three writes `/projects` makes to it (#404, epic
 * #403).
 *
 * ## Search and paging are the API's, not this file's
 *
 * `GET /projects` matches a case-insensitive substring over the name and the
 * slug across every page, and slices what is left. Filtering a page
 * client-side would search 25 rows and call it a search over the deployment's
 * projects — the quiet lie `useAvailableRepositories` states the same rule
 * against.
 *
 * ## Not polled
 *
 * A project list changes when somebody on this screen changes it. There is no
 * background process that creates projects, so a poll would spend a request a
 * tick to re-answer a question whose answer this hook already wrote.
 *
 * ## The write results are the API's rows
 *
 * `create` and `update` resolve with what the API returned and REJECT with
 * `ApiError` on its refusals — the 409 for a taken slug above all, which is
 * refused rather than silently suffixed and therefore has to be rendered as a
 * refusal rather than swallowed. The caller shows the message; this hook does
 * not invent one.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  createProject,
  deleteProject,
  getProjects,
  updateProject,
  type CreateProjectInput,
  type UpdateProjectInput,
} from '../services/api';
import type { Project, ProjectDeletion } from '../types/projects';
import { useIsMounted } from './useIsMounted';

/** The API's own default, stated so the summary and the request agree. */
export const PROJECTS_PAGE_SIZE = 25;

export interface UseProjectsResult {
  projects: Project[];
  total: number;
  page: number;
  totalPages: number;
  isLoading: boolean;
  /** Why the list could not be read, if it could not. */
  error: string | null;
  /** The search being asked for. */
  search: string;
  goToPage: (page: number) => void;
  /** Apply a search, which starts again at page 1. */
  applySearch: (search: string) => void;
  refresh: () => Promise<void>;
  create: (input: CreateProjectInput) => Promise<Project>;
  update: (id: string, input: UpdateProjectInput) => Promise<Project>;
  /** Resolves with how many repositories the deletion left unassigned. */
  remove: (id: string) => Promise<ProjectDeletion>;
  /**
   * Correct one project's `repositoryCount` after a repository moved.
   *
   * Local, because the alternative is a full re-read of the project list on
   * every assignment — and the count is the one field on the row that a write
   * elsewhere on the screen can invalidate. Clamped at zero so a double
   * delivery cannot produce a negative count on screen.
   */
  adjustRepositoryCount: (projectId: string, delta: number) => void;
}

export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<Project[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Every `setState` past an `await` is guarded.
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const answer = await getProjects({
        page,
        pageSize: PROJECTS_PAGE_SIZE,
        search,
      });
      if (isMounted()) {
        setProjects(answer.items);
        setTotal(answer.total);
        setTotalPages(answer.totalPages);
      }
    } catch (err) {
      if (isMounted()) {
        setError(
          err instanceof Error
            ? err.message
            : 'The project list could not be read.',
        );
        setProjects([]);
        setTotal(0);
        setTotalPages(0);
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted, page, search]);

  // Reads on mount and again whenever the requested page or search changes.
  // The two writes before the first `await` are no-ops on mount and are the
  // spinner the operator is owed afterwards — see `useAvailableRepositories`.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount and on page/search change, see above
    void refresh();
  }, [refresh]);

  const goToPage = useCallback((next: number) => setPage(next), []);

  const applySearch = useCallback((next: string) => {
    setSearch(next);
    // Page 4 of the old result set is not page 4 of the new one, and asking
    // for it would answer an empty page that reads like "nothing matched".
    setPage(1);
  }, []);

  const create = useCallback(
    async (input: CreateProjectInput) => {
      const created = await createProject(input);
      // Re-read rather than splice: the list is paged and sorted server-side,
      // so where a new project belongs is the API's answer and not this
      // file's guess.
      await refresh();
      return created;
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, input: UpdateProjectInput) => {
      const updated = await updateProject(id, input);
      if (isMounted()) {
        setProjects((current) =>
          // `repositoryCount` comes back on the response, so replacing the
          // whole row cannot drift it.
          current.map((project) => (project.id === id ? updated : project)),
        );
      }
      return updated;
    },
    [isMounted],
  );

  const remove = useCallback(
    async (id: string) => {
      const deletion = await deleteProject(id);
      await refresh();
      return deletion;
    },
    [refresh],
  );

  const adjustRepositoryCount = useCallback(
    (projectId: string, delta: number) => {
      if (!isMounted()) return;
      setProjects((current) =>
        current.map((project) =>
          project.id === projectId
            ? {
                ...project,
                repositoryCount: Math.max(0, project.repositoryCount + delta),
              }
            : project,
        ),
      );
    },
    [isMounted],
  );

  return {
    projects,
    total,
    page,
    totalPages,
    isLoading,
    error,
    search,
    goToPage,
    applySearch,
    refresh,
    create,
    update,
    remove,
    adjustRepositoryCount,
  };
}

export default useProjects;
