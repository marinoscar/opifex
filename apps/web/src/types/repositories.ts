/**
 * `GET /api/repositories/available`, as the Control Center reads it (#401).
 *
 * A mirror of `apps/api/src/repositories/dto/available-repository.dto.ts`,
 * written against that file rather than guessed at.
 *
 * ## Both vocabularies are unions, and both renderers still fall back
 *
 * `status` and `admission` are closed sets the UI has to BRANCH on — seven
 * remedies and three marks — so a union is what turns an unhandled member into
 * a compile error instead of a blank panel. Every renderer in
 * `config/availableRepositories.ts` nevertheless handles a member this build
 * has never heard of, for the same reason `config/supervisorModel.ts` does:
 * the API may publish an eighth status before this build knows about it, and
 * "we do not recognise this, here is what the API said" is a better sentence
 * than nothing at all.
 *
 * ## A failure is a 200, so there is one shape and never two
 *
 * `no_credential`, `invalid_credential`, `refused`, `rate_limited`,
 * `unreachable` and `failed` all arrive as successful responses carrying
 * `repositories: []`. Nothing in the UI has to tell an HTTP error apart from a
 * finding, which is the whole reason the API answers this way. What `ApiError`
 * still means here is that the REQUEST failed — a 403 on the account, or an
 * API that is down — which is a different thing and is reported separately.
 */

/**
 * Why the list is what it is. Each member names a different remedy.
 *
 * `refused` is the one worth keeping apart from `invalid_credential`: GitHub
 * accepted the token and would not serve the request, so the fix is the
 * token's repository access rather than a new token.
 */
export type AvailableRepositoryStatus =
  | 'ok'
  | 'no_credential'
  | 'invalid_credential'
  | 'refused'
  | 'rate_limited'
  | 'unreachable'
  | 'failed';

/**
 * Whether one repository can be registered, and if not, why not.
 *
 * `registered` outranks `archived` when both apply — the API decides this, not
 * the UI — because only `registered` has somewhere to send the operator.
 */
export type RepositoryAdmission = 'available' | 'registered' | 'archived';

/** One repository the configured credential can reach. Never hidden for its admission. */
export interface AvailableRepository {
  owner: string;
  name: string;
  /** `owner/name`, so nothing here reassembles it. */
  fullName: string;
  description: string | null;
  /** What a work order would branch from, straight from GitHub. */
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  /** ISO-8601, or null when GitHub did not say. Drives the API's order. */
  pushedAt: string | null;
  admission: RepositoryAdmission;
  /**
   * The existing registration's id when `admission` is `registered`, else
   * null — so this build can send the operator to the row they were about to
   * add again rather than only refusing them.
   */
  repositoryId: string | null;
}

/** The whole answer. One object, whatever happened. */
export interface AvailableRepositories {
  status: AvailableRepositoryStatus;
  /** One human sentence, safe to render. Never contains the GitHub token. */
  detail: string;
  /**
   * The requested page. Empty on every failure, and possibly on success.
   *
   * **Pre-sorted by the API** — addable, then already registered, then
   * archived, most recently pushed first within each group — and that order is
   * deliberate. Nothing in `apps/web` re-sorts it.
   */
  repositories: AvailableRepository[];
  page: number;
  pageSize: number;
  /** Rows matching `search`, across all pages. */
  total: number;
  totalPages: number;
  /**
   * Rows the credential reaches BEFORE `search`. Published separately from
   * `total` so this build can tell "your search matched nothing" from "the
   * token reaches nothing" — different sentences with different fixes.
   */
  reachable: number;
  /** The search the API applied, echoed back. Null when none was given. */
  search: string | null;
  /** True when GitHub's listing hit its page cap, so `reachable` is partial. */
  truncated: boolean;
  checkedAt: string;
}
