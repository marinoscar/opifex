/**
 * Projects — the grouping repositories are managed inside (#404, epic #403).
 *
 * A mirror of `apps/api/src/projects/dto/project.dto.ts`, written against that
 * file rather than guessed at.
 *
 * ## A project carries no authority
 *
 * Nothing reads `projectId` to decide whether a run may happen. It is a label
 * an operator files repositories under, which is why the whole module is gated
 * on the same `projects:read` / `projects:write` pair `RepositoriesController`
 * already enforced — a project is administered by whoever administers the
 * repositories in it.
 *
 * ## `null` is a state, not a gap
 *
 * Every repository registered before #404 has `projectId: null`, and such a
 * repository is still observed, still dispatchable and still walked up the
 * enablement ladder. `GET /api/repositories?projectId=none` is how that bucket
 * is asked for; there is deliberately no `GET /api/projects/{id}/repositories`,
 * because a second listing endpoint would have had no answer for it.
 */

/** One project, as `projectResponseSchema` serialises it. */
export interface Project {
  id: string;
  /**
   * The stable handle. Derived from `name` once, at creation, and never
   * re-derived by a rename — everything that referenced the project used it.
   */
  slug: string;
  name: string;
  description: string | null;
  /**
   * How many repositories are assigned right now.
   *
   * Carried on the row because the only question anybody asks of a project
   * list is how much is in each one, and answering it per row otherwise costs
   * a request per project.
   */
  repositoryCount: number;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/projects` — flat pagination, the shape the service returns. */
export interface ProjectListPage {
  items: Project[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * What deleting a project actually did.
 *
 * The count is the point: the repositories were NOT deleted with it, and the
 * API says how many are now unassigned so a caller can report the fact rather
 * than assert it.
 */
export interface ProjectDeletion {
  id: string;
  slug: string;
  unassignedRepositories: number;
}

/**
 * The selected group on `/projects`.
 *
 * `'none'` is the unassigned bucket and is a first-class member of this union
 * rather than a null, for the same reason it is a member of the API's
 * `projectId` filter: unassigned is an ANSWER to "which project", not the
 * absence of a question.
 */
export type ProjectScope =
  { kind: 'unassigned' } | { kind: 'project'; id: string };

/** The value `GET /api/repositories?projectId=` takes for a scope. */
export function scopeQueryValue(scope: ProjectScope): string {
  return scope.kind === 'unassigned' ? 'none' : scope.id;
}

/**
 * The scope a `?project=` query value names — the inverse of the above (#461).
 *
 * Deliberately the SAME vocabulary the API's filter takes, so `/projects` and
 * `GET /repositories?projectId=` are read the same way and there is no third
 * spelling of "unassigned" to keep in step. An ABSENT parameter is unassigned
 * too, because the bare `/projects` the navigation rail points at is the
 * bucket every repository registered before #404 is in, and that has been the
 * screen's landing state since it shipped.
 *
 * Anything else is taken as a project id and passed to the API rather than
 * checked against the loaded list first: the list is paginated and searchable,
 * so "not on this page" and "does not exist" are different facts and only the
 * API can tell them apart.
 */
export function scopeFromQueryValue(value: string | null): ProjectScope {
  return value === null || value === 'none'
    ? { kind: 'unassigned' }
    : { kind: 'project', id: value };
}
