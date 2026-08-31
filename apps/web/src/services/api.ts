const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
}

class ApiService {
  private accessToken: string | null = null;
  private refreshPromise: Promise<boolean> | null = null;

  setAccessToken(token: string | null) {
    this.accessToken = token;
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  private async request<T>(
    endpoint: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const { skipAuth = false, ...fetchOptions } = options;

    const headers: HeadersInit = {
      ...fetchOptions.headers,
    };

    // Only set Content-Type for requests with a body (Fastify 5 is strict about this)
    if (fetchOptions.body) {
      (headers as Record<string, string>)['Content-Type'] = 'application/json';
    }

    if (!skipAuth && this.accessToken) {
      (headers as Record<string, string>)['Authorization'] =
        `Bearer ${this.accessToken}`;
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...fetchOptions,
      headers,
      credentials: 'include', // Include cookies for refresh token
    });

    if (response.status === 401 && !skipAuth) {
      // Try to refresh token (only once, avoid infinite loops)
      const refreshed = await this.refreshToken();
      if (refreshed) {
        // Update authorization header with new token and retry ONCE
        const retryHeaders: HeadersInit = {
          'Content-Type': 'application/json',
          ...fetchOptions.headers,
          Authorization: `Bearer ${this.accessToken}`,
        };

        const retryResponse = await fetch(`${API_BASE_URL}${endpoint}`, {
          ...fetchOptions,
          headers: retryHeaders,
          credentials: 'include',
        });

        if (!retryResponse.ok) {
          const error = await retryResponse.json().catch(() => ({}));
          throw new ApiError(
            error.message || 'Request failed',
            retryResponse.status,
            error.code,
            error.details,
          );
        }

        if (retryResponse.status === 204) {
          return undefined as T;
        }

        const data = await retryResponse.json();
        return data.data ?? data;
      }
      throw new ApiError('Unauthorized', 401);
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ApiError(
        error.message || 'Request failed',
        response.status,
        error.code,
        error.details,
      );
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    const data = await response.json();
    return data.data ?? data;
  }

  async refreshToken(): Promise<boolean> {
    // If a refresh is already in progress, wait for it
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    // Start a new refresh
    this.refreshPromise = this.doRefreshToken();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefreshToken(): Promise<boolean> {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) {
        this.accessToken = null;
        return false;
      }

      const responseData = await response.json();
      // Unwrap the { data: { accessToken } } structure from TransformInterceptor
      const tokenData = responseData.data ?? responseData;

      // Validate that we actually got a token
      if (!tokenData.accessToken || typeof tokenData.accessToken !== 'string') {
        this.accessToken = null;
        return false;
      }

      this.accessToken = tokenData.accessToken;
      return true;
    } catch {
      this.accessToken = null;
      return false;
    }
  }

  // Generic methods
  get<T>(endpoint: string, options?: RequestOptions) {
    return this.request<T>(endpoint, { ...options, method: 'GET' });
  }

  post<T>(endpoint: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>(endpoint, {
      ...options,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  put<T>(endpoint: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  patch<T>(endpoint: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  delete<T>(endpoint: string, options?: RequestOptions) {
    return this.request<T>(endpoint, { ...options, method: 'DELETE' });
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const api = new ApiService();

// Import types
import type {
  AllowlistResponse,
  AllowedEmailEntry,
  UsersResponse,
  UserListItem,
  DeviceActivationInfo,
  DeviceAuthorizationResponse,
  PersonalAccessToken,
  PatCreatedResponse,
  PatDurationUnit,
  NotificationConfig,
  PushSubscriptionRecord,
} from '../types';
import type {
  ApprovalDetail,
  ApprovalListItem,
  ClassApprovalRates,
  DecideApprovalInput,
  DecideApprovalResult,
  OpenApprovalStatus,
} from '../types/approvals';
import type {
  ManualDemotionResult,
  PromotionLadder,
  PromotionStateDetail,
  TrustGrantDetail,
  TrustGrantFilters,
  TrustGrantListItem,
} from '../types/trust';
import type { AuditEventsPage } from '../types/audit';
import type {
  ApplySteeringInput,
  ProposeSteeringInput,
  SteeringApplyResult,
  SteeringProposal,
} from '../types/steering';
import type { ClaudeAuthSession } from '../types/claudeAuth';
import type { FleetHealth, ReadinessHealth } from '../types/health';
import type {
  OperatorSettingsDocument,
  OperatorSettingsPatch,
} from '../types/operatorSettings';
import type {
  OperatorProbeName,
  OperatorProbeResult,
} from '../types/operatorProbes';
import type { SupervisorModelCatalog } from '../types/supervisorModels';
import type { AvailableRepositories } from '../types/repositories';
import type { LabelProvisioningReport } from '../types/repositoryLabels';
import type {
  Project,
  ProjectDeletion,
  ProjectListPage,
} from '../types/projects';
import type {
  MetricsSummary,
  QueueEntry,
  RunDetail,
  RunEvent,
  RunStatus,
  RunSummary,
  CostSummary,
  RepositorySummary,
  WorkOrderDetail,
} from '../types/cockpit';
import type {
  ExhaustedWindow,
  QuotaSummary,
  RateLimitEpisode,
  RateLimitReason,
} from '../types/quota';

// Allowlist API
/**
 * The two facts the queue write endpoints keep apart (#116).
 *
 * `reconciled` is always false: the label is the request, and the reconciler
 * acts on it next tick. A UI that collapsed these into one boolean would be
 * back to the optimistic lie #85 asks it to avoid.
 */
export interface QueueSteerResult {
  workOrderId: string;
  identity: string;
  label: string;
  labelWritten: boolean;
  reconciled: boolean;
  effect: string;
}

export interface RepositoriesPage {
  items: RepositorySummary[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * `GET /repositories` — every repository Opifex is registered against.
 *
 * `projectId` takes a uuid or the literal `'none'`, which is the unassigned
 * bucket. That is a member of the filter rather than a separate flag because
 * unassigned is an ANSWER to "which project", and every repository registered
 * before #404 is in it.
 *
 * `retired` OMITTED means both. Defaulting it to `false` here would hide a
 * repository the moment it was retired, leaving an operator unable to find the
 * thing they just stood down in order to un-retire it.
 */
export async function getRepositories(
  params: {
    page?: number;
    pageSize?: number;
    observeEnabled?: boolean;
    dispatchEnabled?: boolean;
    /** A project id, or `'none'` for the repositories in no project at all. */
    projectId?: string;
    retired?: boolean;
  } = {},
  signal?: AbortSignal,
): Promise<RepositoriesPage> {
  const searchParams = new URLSearchParams();
  if (params.page) searchParams.set('page', String(params.page));
  if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params.observeEnabled !== undefined) {
    searchParams.set('observeEnabled', String(params.observeEnabled));
  }
  if (params.dispatchEnabled !== undefined) {
    searchParams.set('dispatchEnabled', String(params.dispatchEnabled));
  }
  if (params.projectId !== undefined) {
    searchParams.set('projectId', params.projectId);
  }
  if (params.retired !== undefined) {
    searchParams.set('retired', String(params.retired));
  }

  const query = searchParams.toString();
  return api.get<RepositoriesPage>(
    query ? `/repositories?${query}` : '/repositories',
    { signal },
  );
}

/**
 * The subset of `UpdateRepositoryDto` the Control Center's ladder writes
 * (#350, epic #332).
 *
 * Every field is optional and omission means "leave it alone" — the API's own
 * rule, since each default lives in the Prisma schema and a PATCH that
 * mentioned a field it was not asked to change would reset it. So the ladder
 * sends only what the operator actually moved.
 *
 * `budgetCeilingUsd` is a NUMBER here and a string on the way back
 * (`RepositorySummary`). That asymmetry is the API's: the column is a Postgres
 * `DECIMAL`, and serialising it out through a JS number would round a spend
 * ceiling. `null` clears it, which is different from omitting it.
 */
export interface UpdateRepositoryInput {
  observeEnabled?: boolean;
  mirrorLabelsEnabled?: boolean;
  specFeedbackEnabled?: boolean;
  dispatchEnabled?: boolean;
  budgetCeilingUsd?: number | null;
  wallClockTimeoutMinutes?: number | null;
  pathConstraints?: string[];
  projectId?: string | null;
}

/**
 * `PATCH /repositories/:id` — change one repository's policy.
 *
 * Requires `projects:write`, which is what `RepositoriesController.update`
 * enforces; the ladder renders read-only without it, and the API refuses the
 * write regardless. Enabling dispatch re-verifies reachability API-side, so
 * this call can fail for a reason the switch itself knows nothing about — the
 * caller surfaces the message rather than assuming the flip took.
 */
export async function updateRepository(
  id: string,
  input: UpdateRepositoryInput,
  signal?: AbortSignal,
): Promise<RepositorySummary> {
  return api.patch<RepositorySummary>(
    `/repositories/${encodeURIComponent(id)}`,
    input,
    { signal },
  );
}

// ---------------------------------------------------------------------------
// Registering a repository, chosen from a list (#401)
// ---------------------------------------------------------------------------

/**
 * `GET /repositories/available` — what the configured GitHub credential can
 * actually reach.
 *
 * Requires `projects:read`, the same permission the registered list above
 * enforces.
 *
 * **This resolves for every finding.** A missing credential, a rejected one,
 * a refused one, an exhausted rate limit and an unreachable GitHub all arrive
 * as 200s carrying a `status`, because "the request failed" and "the request
 * found a failure" are the two things this endpoint exists to tell apart. A
 * rejection from here therefore means the REQUEST failed — the account may not
 * read repositories, or the API is down — and never that the credential is
 * bad.
 */
export async function getAvailableRepositories(
  params: { page?: number; pageSize?: number; search?: string } = {},
  signal?: AbortSignal,
): Promise<AvailableRepositories> {
  const searchParams = new URLSearchParams();
  if (params.page) searchParams.set('page', String(params.page));
  if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));
  // Trimmed and dropped when empty: the API's schema rejects a blank `search`
  // with a 400, and "I cleared the box" means no filter rather than a filter
  // matching nothing.
  const search = params.search?.trim() ?? '';
  if (search !== '') searchParams.set('search', search);

  const query = searchParams.toString();
  return api.get<AvailableRepositories>(
    query ? `/repositories/available?${query}` : '/repositories/available',
    { signal },
  );
}

/**
 * What `POST /repositories` accepts. Deliberately the two identifying fields
 * and nothing else.
 *
 * Every policy flag is optional and every default lives in the Prisma schema,
 * so omitting them is how a registration gets the defaults the API documents:
 * `observeEnabled` true, `dispatchEnabled`, `mirrorLabelsEnabled` and
 * `specFeedbackEnabled` false. A newly added repository is therefore observed
 * and never run — VISION §12's staged rollout, expressed by sending less
 * rather than by sending a copy of the defaults that could drift from them.
 */
export interface CreateRepositoryInput {
  owner: string;
  name: string;
  projectId?: string | null;
}

/**
 * `POST /repositories` — register a repository for Opifex to watch.
 *
 * Requires `projects:write`. The API verifies the repository is reachable with
 * the configured credential before accepting it, so this call has real
 * failures the caller must render rather than validation to invent:
 *
 *  - **400** — not reachable, archived, or a name GitHub could not hold;
 *  - **409** — already registered;
 *  - **503** — the GitHub credential is missing or expired.
 *
 * Rejects with `ApiError`, whose `status` is how those are told apart. The
 * picker marks the rows that would produce a 400 or a 409 so an operator is
 * not walked into one, but the token is resolved per request and can change
 * between the listing and the write — so these stay real states, not
 * impossible ones.
 */
/**
 * What `POST /repositories` ANSWERS: the repository, plus what happened to its
 * labels (#415).
 *
 * `labelProvisioning` is an event of the registration rather than a property
 * of the repository, which is why it is a wider type here and is absent from
 * `RepositorySummary` — `GET /repositories` would otherwise have to call
 * GitHub once per row, or publish a field that is always null there.
 *
 * **Null does not mean "no labels".** It is the belt-and-braces case: a bug in
 * provisioning itself must not cost a registration. A GitHub refusal arrives
 * as a full report with `status: 'refused'`, not as null — and that report's
 * own counts are null only when the labels could not be READ.
 */
export interface RegisteredRepository extends RepositorySummary {
  labelProvisioning: LabelProvisioningReport | null;
}

export async function createRepository(
  input: CreateRepositoryInput,
  signal?: AbortSignal,
): Promise<RegisteredRepository> {
  return api.post<RegisteredRepository>('/repositories', input, { signal });
}

// ---------------------------------------------------------------------------
// The factory label taxonomy on one repository (#415)
// ---------------------------------------------------------------------------

/**
 * `GET /repositories/:id/labels` — which declared factory labels exist on
 * GitHub, as of now.
 *
 * Requires `projects:read`. **Writes nothing**, and answers an OBSERVATION
 * with a `checkedAt` rather than a stored fact: nothing in Opifex remembers
 * this between calls, because a label deleted on GitHub a minute later would
 * make a remembered answer a lie.
 *
 * **A GitHub failure is a 200 carrying a `status`**, never an error status —
 * "the request failed" and "the request found a failure" are the two things
 * this endpoint exists to tell apart. So a rejection from here means the
 * REQUEST failed (the account lacks `projects:read`, the id is not a
 * registered repository, or the API is down) and never that GitHub said no.
 *
 * When the label list could not be read at all, `labels` is empty and all
 * seven counts are **null — which means "not read", never zero**. See
 * `config/repositoryLabels.ts`: no count may be rendered from such a report.
 */
export async function getRepositoryLabels(
  id: string,
  signal?: AbortSignal,
): Promise<LabelProvisioningReport> {
  return api.get<LabelProvisioningReport>(
    `/repositories/${encodeURIComponent(id)}/labels`,
    { signal },
  );
}

/**
 * `POST /repositories/:id/labels` — create the missing declared labels. **200,
 * not 201**: the answer is a report about a repository that already existed,
 * not a created resource.
 *
 * Requires `projects:write`. Creates what is missing, updates what has
 * drifted, and **never deletes** — a label outside the taxonomy is left alone,
 * because deleting one strips it from every issue carrying it. Idempotent: run
 * twice, the second run writes nothing and reports `unchanged`.
 *
 * Answers the same shape as the inspection above, with `attempted: true` —
 * which says only that this call TRIED to write, not that anything landed, so
 * a refusal is again a 200 with `status: 'refused'` and `attempted: true`.
 * Read `action` for what this call did; `stateBefore` is what GitHub had
 * before it and is deliberately not rewritten by a successful write.
 *
 * **A refusal here can still carry real counts.** If the label list was read
 * and GitHub then refused the write, the report knows exactly what is on the
 * repository — and may have created some labels before being cut off. Only a
 * failure of the READ nulls the counts.
 */
export async function repairRepositoryLabels(
  id: string,
  signal?: AbortSignal,
): Promise<LabelProvisioningReport> {
  return api.post<LabelProvisioningReport>(
    `/repositories/${encodeURIComponent(id)}/labels`,
    {},
    { signal },
  );
}

// ---------------------------------------------------------------------------
// Standing a repository down, and taking it away (#405)
// ---------------------------------------------------------------------------

/**
 * `POST /repositories/:id/retire` — stand a repository down, keeping its
 * history.
 *
 * This is the removal action for anything that has ever run. It turns all four
 * rungs off in one act and STORES `retiredAt`, which is why a retired
 * repository can be told apart from one that was merely never enabled — the
 * flags alone cannot make that distinction, and un-retire would have nothing
 * to undo.
 *
 * Idempotent: retiring an already-retired repository returns it unchanged and
 * writes no second audit row. `reason` is optional, because requiring a
 * justification produces the string "asdf".
 */
export async function retireRepository(
  id: string,
  reason?: string,
  signal?: AbortSignal,
): Promise<RepositorySummary> {
  return api.post<RepositorySummary>(
    `/repositories/${encodeURIComponent(id)}/retire`,
    reason ? { reason } : {},
    { signal },
  );
}

/**
 * `POST /repositories/:id/unretire` — put a retired repository back on the
 * ladder.
 *
 * Clears `retiredAt`. It does NOT restore the rungs that were on before:
 * un-retiring returns the repository to the bottom of the ladder, and the
 * operator climbs it again deliberately.
 */
export async function unretireRepository(
  id: string,
  reason?: string,
  signal?: AbortSignal,
): Promise<RepositorySummary> {
  return api.post<RepositorySummary>(
    `/repositories/${encodeURIComponent(id)}/unretire`,
    reason ? { reason } : {},
    { signal },
  );
}

/**
 * `DELETE /repositories/:id` — de-register a repository entirely. 204.
 *
 * **Refused with a 400 while the repository has work orders**, because
 * deleting would cascade away runs and their provenance — the graph VISION §5
 * calls the product. This is therefore only honest for a repository nothing
 * has ever happened in; anything with history is retired instead.
 */
export async function deleteRepository(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  await api.delete<void>(`/repositories/${encodeURIComponent(id)}`, { signal });
}

/**
 * How many work orders exist for one repository — or the honest admission that
 * this build could not find out.
 *
 * `DELETE /repositories/:id` is refused with a 400 while the repository has
 * work orders, because deleting would cascade away runs and their provenance.
 * Nothing on `RepositorySummary` says whether that is the case, so offering a
 * De-register button on every row would mean offering it exactly where it
 * fails — on the repositories an operator most wants to tidy. This is the
 * question that tells the two apart, asked once when the removal dialog opens.
 *
 * **Resolves for every outcome**, like `probeRepositoryAccess`. The list is
 * gated on `workorders:read`, which is a different permission from the one
 * that opens this screen, so a 403 is a fact about the ACCOUNT rather than a
 * count of zero — and `unknown` renders as "delete is not offered because we
 * could not check", never as "there is nothing here".
 */
export type RepositoryWorkOrderCount =
  { state: 'counted'; total: number } | { state: 'unknown'; detail: string };

export async function countRepositoryWorkOrders(
  fullName: string,
  signal?: AbortSignal,
): Promise<RepositoryWorkOrderCount> {
  try {
    // `pageSize: 1` — only `total` is read, and asking for a page of rows
    // nobody renders would cost the API a query it does not need to run.
    const page = await api.get<{ total: number }>(
      `/work-orders?pageSize=1&repository=${encodeURIComponent(fullName)}`,
      { signal },
    );
    return { state: 'counted', total: page.total };
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      return {
        state: 'unknown',
        detail:
          'This account may not read work orders, which needs ' +
          'workorders:read. That is a fact about the account, not a count.',
      };
    }
    return {
      state: 'unknown',
      detail:
        error instanceof ApiError
          ? `GET /api/work-orders answered ${error.status}: ${error.message}`
          : 'The work order count could not be read.',
    };
  }
}

// ---------------------------------------------------------------------------
// Projects (#404, epic #403)
// ---------------------------------------------------------------------------

/**
 * `GET /projects` — the groups, each carrying how many repositories are in it.
 *
 * Repositories with no project are NOT listed here and are not missing: ask
 * for them with `getRepositories({ projectId: 'none' })`.
 */
export async function getProjects(
  params: { page?: number; pageSize?: number; search?: string } = {},
  signal?: AbortSignal,
): Promise<ProjectListPage> {
  const searchParams = new URLSearchParams();
  if (params.page) searchParams.set('page', String(params.page));
  if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));
  // Trimmed and dropped when empty: the API's schema rejects a blank `search`
  // with a 400, and "I cleared the box" means no filter rather than a filter
  // matching nothing.
  const search = params.search?.trim() ?? '';
  if (search !== '') searchParams.set('search', search);

  const query = searchParams.toString();
  return api.get<ProjectListPage>(query ? `/projects?${query}` : '/projects', {
    signal,
  });
}

/**
 * What `POST /projects` accepts.
 *
 * `slug` is optional and derived from `name` when omitted. Supplying one is
 * how an operator gets a handle shorter or steadier than the name.
 */
export interface CreateProjectInput {
  name: string;
  slug?: string;
  description?: string | null;
}

/**
 * `POST /projects` — 201 with the created project.
 *
 * Rejects with `ApiError`:
 *  - **409** — that slug is taken. Never silently suffixed, and the message
 *    names the slug even when it was derived and nobody typed it.
 *  - **400** — a name with no character in the slug alphabet derives nothing,
 *    so an explicit slug is asked for rather than an identifier invented.
 */
export async function createProject(
  input: CreateProjectInput,
  signal?: AbortSignal,
): Promise<Project> {
  return api.post<Project>('/projects', input, { signal });
}

/**
 * What `PATCH /projects/:id` accepts. Omitted fields are left alone, and at
 * least one of the three must be present — a body with none is a 400 rather
 * than a 200 reporting success for a write that did nothing.
 *
 * **Renaming does not move the slug.** Derivation happens once, at creation.
 */
export interface UpdateProjectInput {
  name?: string;
  slug?: string;
  description?: string | null;
}

export async function updateProject(
  id: string,
  input: UpdateProjectInput,
  signal?: AbortSignal,
): Promise<Project> {
  return api.patch<Project>(`/projects/${encodeURIComponent(id)}`, input, {
    signal,
  });
}

/**
 * `DELETE /projects/:id` — removes the label, never the repositories.
 *
 * They become unassigned: still registered, still observed, still dispatchable.
 * The response says how many, so a caller can report the non-cascade rather
 * than assert it. Unlike deleting a repository this is never refused for
 * having contents — a project owns no work orders, runs or events.
 */
export async function deleteProject(
  id: string,
  signal?: AbortSignal,
): Promise<ProjectDeletion> {
  return api.delete<ProjectDeletion>(`/projects/${encodeURIComponent(id)}`, {
    signal,
  });
}

/**
 * `PUT /projects/:id/repositories/:repositoryId` — file a repository here.
 *
 * Idempotent, and it MOVES: a repository already in another project is
 * reassigned to this one rather than refused.
 */
export async function assignRepositoryToProject(
  projectId: string,
  repositoryId: string,
  signal?: AbortSignal,
): Promise<RepositorySummary> {
  return api.put<RepositorySummary>(
    `/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repositoryId)}`,
    undefined,
    { signal },
  );
}

/**
 * `DELETE /projects/:id/repositories/:repositoryId` — remove the grouping, not
 * the repository. It stays registered and becomes unassigned.
 *
 * 404 when the repository is in a DIFFERENT project: the path asserts it is in
 * this one, so a stale screen cannot unassign it from wherever it really went.
 */
export async function unassignRepositoryFromProject(
  projectId: string,
  repositoryId: string,
  signal?: AbortSignal,
): Promise<RepositorySummary> {
  return api.delete<RepositorySummary>(
    `/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repositoryId)}`,
    { signal },
  );
}

/**
 * What the per-repository access probe answered — including "nothing did".
 *
 *  - `reachable` — the probe read this repository with the configured token.
 *  - `unreachable` — the probe ran and could NOT read it. The case worth
 *    having: a fine-grained PAT that is valid, passes a `/rate_limit` check,
 *    and does not cover *this* repository. Otherwise that is discovered when a
 *    run fails at the end.
 *  - `not-implemented` — this deployment's API has no such probe yet (#338).
 *    Structural, like `config/readiness.ts`'s `unverifiable`: it clears when
 *    the endpoint ships, not when you press the button again.
 *  - `forbidden` — the probe exists and this account may not ask it. A fact
 *    about the ACCOUNT, never about the repository.
 *  - `failed` — the call itself did not produce an answer.
 */
export type RepositoryAccessProbeState =
  'reachable' | 'unreachable' | 'not-implemented' | 'forbidden' | 'failed';

export interface RepositoryAccessProbeResult {
  state: RepositoryAccessProbeState;
  /** A sentence for the operator. The API's own `detail` when there is one. */
  detail: string;
  /** When the probe ran, as the API reported it. Null when it did not run. */
  checkedAt: string | null;
}

/** The `{ ok, detail, checkedAt }` shape #338 specifies for every probe. */
interface ProbeResponse {
  ok: boolean;
  detail?: string;
  checkedAt?: string;
}

/**
 * `POST /operator-settings/probes/github-repo` — can the configured GitHub
 * credential actually read THIS repository?
 *
 * ## It is one function because the endpoint does not exist yet
 *
 * #338 is being built in parallel and is not on `main`. Everything the ladder
 * knows about this probe — its path, its request body, its response shape, and
 * what a 404 from it means today — is in this function, so wiring it up for
 * real is an edit here and nowhere else.
 *
 * ## It resolves rather than throwing
 *
 * A missing probe is not an error the operator did anything about, and the
 * section must not be blocked on it. So every outcome comes back as a state:
 * the caller renders "not yet verifiable" for the two it cannot conclude
 * from, exactly as the readiness chain does, and never paints a green check it
 * did not earn.
 *
 * ## Why a 404 reads as "not built yet"
 *
 * Nest answers an unrouted path with 404, and that is the ONLY 404 this call
 * can receive today. Once #338 lands, a 404 could instead mean the repository
 * id is unknown — so the API's own message is carried into `detail` verbatim
 * rather than replaced, leaving the difference visible on screen even while
 * this branch cannot tell the two apart.
 */
export async function probeRepositoryAccess(
  repositoryId: string,
  signal?: AbortSignal,
): Promise<RepositoryAccessProbeResult> {
  try {
    const response = await api.post<ProbeResponse>(
      '/operator-settings/probes/github-repo',
      { repositoryId },
      { signal },
    );

    return {
      state: response.ok ? 'reachable' : 'unreachable',
      detail:
        response.detail ??
        (response.ok
          ? 'The configured GitHub credential can read this repository.'
          : 'The configured GitHub credential could not read this repository.'),
      checkedAt: response.checkedAt ?? null,
    };
  } catch (error) {
    return probeFailure(error);
  }
}

function probeFailure(error: unknown): RepositoryAccessProbeResult {
  if (error instanceof ApiError) {
    if (error.status === 404 || error.status === 501) {
      return {
        state: 'not-implemented',
        detail:
          'POST /api/operator-settings/probes/github-repo answered ' +
          `${error.status}: ${error.message}. The per-repository access ` +
          'probe arrives in #338; until then nothing here has tested this ' +
          'credential against this repository.',
        checkedAt: null,
      };
    }
    if (error.status === 403) {
      return {
        state: 'forbidden',
        detail:
          'This account may not run probes, so the access test says nothing ' +
          'either way about the repository.',
        checkedAt: null,
      };
    }
    return {
      state: 'failed',
      detail: `The probe answered ${error.status}: ${error.message}`,
      checkedAt: null,
    };
  }

  return {
    state: 'failed',
    detail:
      error instanceof Error
        ? `The probe could not be called: ${error.message}`
        : 'The probe could not be called.',
    checkedAt: null,
  };
}

// ---------------------------------------------------------------------------
// The Control Center's readiness chain (#347, epic #332)
// ---------------------------------------------------------------------------

/**
 * `GET /health/ready` — the readiness probe, read for its fleet entry.
 *
 * Public on the API, and called here anyway with the normal client so a 503
 * arrives as an `ApiError` like everything else. Readiness only goes red on
 * the DATABASE indicator; an empty or disabled fleet is reported and stays
 * green, deliberately (see `FleetIndicator`). So a throw from this call means
 * the control plane could not reach its own database — which is worth saying
 * out loud rather than rendering as an empty chain.
 */
export async function getReadinessHealth(
  signal?: AbortSignal,
): Promise<ReadinessHealth> {
  return api.get<ReadinessHealth>('/health/ready', { signal });
}

/**
 * The fleet entry out of a readiness payload, or null if it is not there.
 *
 * `info` carries the indicators that are up and `details` carries all of them,
 * so on a red readiness the fleet is only in `details`. Reading `info` first
 * and falling back is what keeps the fleet visible on the one screen where a
 * database outage would otherwise blank it.
 */
export function fleetFromReadiness(
  health: ReadinessHealth | null,
): FleetHealth | null {
  const entry = health?.info?.fleet ?? health?.details?.fleet;
  return entry ? (entry as unknown as FleetHealth) : null;
}

/**
 * How many repositories are registered, and how many may be dispatched into.
 *
 * TWO requests with `pageSize: 1` rather than one that pages through them:
 * `total` is what the question needs and the endpoint already computes it, so
 * counting rows in the browser would be both slower and wrong past the first
 * page. Requires `projects:read`, which an operator holding only
 * `system_settings:read` may not have — the caller renders that refusal as
 * "not verifiable with this account" rather than as zero.
 */
export async function getRepositoryEnablementCounts(
  signal?: AbortSignal,
): Promise<{ registered: number; dispatchEnabled: number }> {
  const [all, dispatchable] = await Promise.all([
    getRepositories({ pageSize: 1 }, signal),
    getRepositories({ pageSize: 1, dispatchEnabled: true }, signal),
  ]);

  return { registered: all.total, dispatchEnabled: dispatchable.total };
}

/** `GET /cost/summary` — spend over a window, with the ceiling beside it. */
export async function getCostSummary(
  days: number,
  signal?: AbortSignal,
): Promise<CostSummary> {
  return api.get<CostSummary>(`/cost/summary?days=${days}`, { signal });
}

/** `GET /work-orders/:idOrIdentity` — one work order, its document and attempts. */
export async function getWorkOrder(
  idOrIdentity: string,
  signal?: AbortSignal,
): Promise<WorkOrderDetail> {
  return api.get<WorkOrderDetail>(
    `/work-orders/${encodeURIComponent(idOrIdentity)}`,
    { signal },
  );
}

/** `POST /queue/:id/hold` — write `factory:hold` to the work order's issue. */
export async function holdWorkOrder(
  workOrderId: string,
): Promise<QueueSteerResult> {
  return api.post<QueueSteerResult>(
    `/queue/${encodeURIComponent(workOrderId)}/hold`,
    {},
  );
}

/** `POST /queue/:id/release` — write `factory:ready`. */
export async function releaseWorkOrder(
  workOrderId: string,
): Promise<QueueSteerResult> {
  return api.post<QueueSteerResult>(
    `/queue/${encodeURIComponent(workOrderId)}/release`,
    {},
  );
}

/**
 * `POST /steering/proposals` — an instruction becomes a PROPOSED label diff.
 *
 * Writes nothing. The proposal comes back to this client and is handed back on
 * apply, because the API stores none of it: scope lives in GitHub labels and
 * nowhere else (`steering.dto.ts`, "What is deliberately not here"). That is
 * why the two calls take a whole proposal rather than an id.
 *
 * `200`, not `202` — nothing has been accepted for later, because nothing has
 * been asked for yet.
 *
 * **At most one of `repository`, `project` and `allRepositories`** (ADR-0020).
 * They are three answers to one question — which repositories this instruction
 * reaches — so the API answers 400 to two of them rather than carrying a
 * precedence rule. `ProposeSteeringInput` makes that a union rather than three
 * optional fields, so a caller here cannot compose the refused request at all.
 */
export async function proposeSteering(
  input: ProposeSteeringInput,
  signal?: AbortSignal,
): Promise<SteeringProposal> {
  return api.post<SteeringProposal>('/steering/proposals', input, { signal });
}

/**
 * `POST /steering/proposals/apply` — the confirmed diff becomes labels.
 *
 * `202 Accepted`, the same status and for the same reason as the queue steer
 * endpoints: the labels are the request, and a reconciler tick acts on them.
 * `labelWritten` in the body — never the status — says whether anything
 * reached GitHub.
 *
 * **`observedInputLabels` is passed through untouched.** It is the baseline the
 * server re-reads each issue against, so a caller that sorted it, filtered it
 * to the two steerable labels or omitted it would leave drift detection
 * looking exactly like it works while detecting nothing.
 *
 * Throws `ApiError` with `status: 409` when the proposal is older than the
 * 30-minute TTL. That is a stale proposal rather than a fault: ask again.
 */
export async function applySteering(
  input: ApplySteeringInput,
): Promise<SteeringApplyResult> {
  return api.post<SteeringApplyResult>('/steering/proposals/apply', input);
}

/**
 * Sort keys `GET /api/allowlist` accepts, mirroring
 * `allowlistQuerySchema.sortBy` (`apps/api/src/allowlist/dto/allowlist-query.dto.ts`).
 */
export type AllowlistSortField = 'email' | 'addedAt' | 'claimedAt';

export async function getAllowlist(params?: {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: 'all' | 'pending' | 'claimed';
  sortBy?: AllowlistSortField;
  sortOrder?: 'asc' | 'desc';
}): Promise<AllowlistResponse> {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params?.search) searchParams.set('search', params.search);
  if (params?.status) searchParams.set('status', params.status);
  if (params?.sortBy) searchParams.set('sortBy', params.sortBy);
  if (params?.sortOrder) searchParams.set('sortOrder', params.sortOrder);

  return api.get<AllowlistResponse>(`/allowlist?${searchParams}`);
}

export async function addToAllowlist(
  email: string,
  notes?: string,
): Promise<AllowedEmailEntry> {
  return api.post<AllowedEmailEntry>('/allowlist', { email, notes });
}

export async function removeFromAllowlist(id: string): Promise<void> {
  await api.delete<void>(`/allowlist/${id}`);
}

// Users API
/**
 * Sort keys `GET /api/users` accepts, mirroring `userListQuerySchema.sortBy`
 * (`apps/api/src/users/dto/user-list-query.dto.ts`). Typed rather than
 * `string` so a DataTable column declaring `sortable` against a field the
 * endpoint would reject is a compile error, not a 400 at runtime.
 */
export type UserSortField = 'email' | 'createdAt' | 'updatedAt';

export async function getUsers(params?: {
  page?: number;
  pageSize?: number;
  search?: string;
  role?: string;
  isActive?: boolean;
  sortBy?: UserSortField;
  sortOrder?: 'asc' | 'desc';
}): Promise<UsersResponse> {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params?.search) searchParams.set('search', params.search);
  if (params?.role) searchParams.set('role', params.role);
  if (params?.isActive !== undefined)
    searchParams.set('isActive', String(params.isActive));
  if (params?.sortBy) searchParams.set('sortBy', params.sortBy);
  if (params?.sortOrder) searchParams.set('sortOrder', params.sortOrder);

  return api.get<UsersResponse>(`/users?${searchParams}`);
}

export async function updateUser(
  id: string,
  data: { displayName?: string; isActive?: boolean },
): Promise<UserListItem> {
  return api.patch<UserListItem>(`/users/${id}`, data);
}

export async function updateUserRoles(
  id: string,
  roles: string[],
): Promise<UserListItem> {
  return api.put<UserListItem>(`/users/${id}/roles`, { roles });
}

// Device Activation API
export async function getDeviceActivationInfo(
  userCode: string,
): Promise<DeviceActivationInfo> {
  return api.get<DeviceActivationInfo>(
    `/auth/device/activate?code=${userCode}`,
  );
}

export async function authorizeDevice(
  userCode: string,
  approve: boolean,
): Promise<DeviceAuthorizationResponse> {
  return api.post<DeviceAuthorizationResponse>('/auth/device/authorize', {
    userCode,
    approve,
  });
}

// Personal Access Tokens API
export async function getPersonalAccessTokens(): Promise<
  PersonalAccessToken[]
> {
  return api.get<PersonalAccessToken[]>('/pat');
}

export async function createPersonalAccessToken(data: {
  name: string;
  durationValue: number;
  durationUnit: PatDurationUnit;
}): Promise<PatCreatedResponse> {
  return api.post<PatCreatedResponse>('/pat', data);
}

export async function revokePersonalAccessToken(id: string): Promise<void> {
  await api.delete<void>(`/pat/${id}`);
}

// ---------------------------------------------------------------------------
// Cockpit API (epic #19)
//
// ALL FOUR OF THESE ENDPOINTS NOW EXIST IN `apps/api`, and the cockpit is
// reachable from the running app: `/metrics/summary`, `/runs` (which is also
// where `?needsAttention=true` is answered), `/queue` and `/events`, plus the
// run detail and run timeline reads below — `/runs/:id` and `/runs/:id/events`.
// They landed one at a time across #163, #164, #165 and #168, and every entry
// in `config/cockpitApi.ts` is now `available: true`.
//
// THIS BLOCK WAS WRITTEN BEFORE ANY OF THEM, deliberately, and the reasoning is
// kept here because it is the record of a decision that turned out well — not
// because anything below is still waiting on a server:
//
//  - The typed boundary is where a response shape is asserted. Writing these
//    first meant the hooks, the panels and their tests were built against
//    `RunSummary` rather than against `any`, and the intended cost of landing
//    an endpoint was a single `false -> true` in `config/cockpitApi.ts`. That
//    is what it actually cost, four times: no panel and no hook changed shape.
//  - Each one has an MSW-backed test, so the request path, the query string and
//    the `{ data }` unwrapping are verified against a stand-in server exactly
//    the way `getUsers` is. That test is what made each declaration a
//    specification of the endpoint rather than a guess about it — and where the
//    real controller disagreed with the guess, the mismatch surfaced at this
//    parse boundary instead of in a component reading `undefined`. See
//    `getRunsNeedingAttention` and `getActivityFeed`, whose `limit` is
//    translated into the `pageSize` those endpoints really paginate by.
//
// `COCKPIT_ENDPOINTS[…].available` still gates whether these are CALLED — every
// cockpit hook reads it into `usePolledResource`'s `enabled` — but with all four
// entries `true` it currently gates nothing shut. It is kept as the mechanism
// the NEXT unbuilt panel declares itself through, not as a brake on these. The
// paths below and the paths in that registry must stay in step: the registry is
// the human-readable half, these are the executable half.
//
// `RunSortField` below mirrors `runsQuerySchema` in `apps/api` (#82), the same
// way `UserSortField` above mirrors its own zod enum. The other cockpit reads
// still declare no sort union, because their query DTOs still declare no `sort`
// — inventing one would be fabricating a contract.
// ---------------------------------------------------------------------------

/**
 * `GET /metrics/summary` — VISION §10's six success metrics in one payload.
 *
 * One request for the whole stat row rather than six, so the dashboard cannot
 * paint a half-updated set of tiles.
 */
export async function getCockpitMetrics(
  signal?: AbortSignal,
): Promise<MetricsSummary> {
  return api.get<MetricsSummary>('/metrics/summary', { signal });
}

/**
 * `GET /runs?needsAttention=true` — the escalation list.
 *
 * `needsAttention` is a SERVER-side filter, not a client-side one, and that is
 * load-bearing: the verdict about whether a run needs a human (VISION §9's
 * watchdog) belongs to the control plane. A UI that filtered by status locally
 * would be re-implementing the watchdog in the browser, out of date by one
 * poll interval and wrong the moment the rules change.
 */
export async function getRunsNeedingAttention(
  params?: { limit?: number },
  signal?: AbortSignal,
): Promise<RunSummary[]> {
  const searchParams = new URLSearchParams({ needsAttention: 'true' });
  // The endpoint paginates like every other list in this API — `page` and
  // `pageSize`, not `limit`. The panel wants the first N and nothing else, so
  // the page size IS the limit here and the envelope is unwrapped for the
  // caller: a dashboard panel has no pager and no use for `total`.
  //
  // This is the reconciliation `types/cockpit.ts` asks for by name: the shapes
  // in that file were written before an endpoint existed, and where one
  // disagrees the parse boundary is where it must surface.
  if (params?.limit) searchParams.set('pageSize', String(params.limit));

  const page = await api.get<{ items: RunSummary[]; total: number }>(
    `/runs?${searchParams}`,
    { signal },
  );
  return page.items;
}

/** What `GET /runs` orders by. Mirrors `runsQuerySchema` in the API (#82). */
export type RunSortField = 'startedAt' | 'lastEventAt' | 'costUsd' | 'status';

export interface RunsPage {
  items: RunSummary[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * `GET /runs` — a page of runs, ordered and filtered by the SERVER.
 *
 * The envelope is kept here, unlike `getRunsNeedingAttention` which unwraps it:
 * a list screen has a pager and genuinely needs `total`, while a dashboard
 * panel wants the first N and nothing else.
 *
 * Only parameters the endpoint actually honours are sent. A control the API
 * cannot answer looks live and does nothing, which is the failure
 * `userListColumns.tsx` calls out by name.
 */
export async function getRuns(
  params: {
    page?: number;
    pageSize?: number;
    status?: RunStatus;
    needsAttention?: boolean;
    sort?: RunSortField;
    direction?: 'asc' | 'desc';
  } = {},
  signal?: AbortSignal,
): Promise<RunsPage> {
  const searchParams = new URLSearchParams();
  if (params.page) searchParams.set('page', String(params.page));
  if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params.status) searchParams.set('status', params.status);
  if (params.needsAttention) searchParams.set('needsAttention', 'true');
  if (params.sort) {
    searchParams.set('sort', params.sort);
    // Only alongside `sort`: a direction with nothing to order by is a
    // parameter the endpoint would ignore, and sending it would suggest
    // otherwise.
    searchParams.set('direction', params.direction ?? 'desc');
  }

  const query = searchParams.toString();
  return api.get<RunsPage>(query ? `/runs?${query}` : '/runs', { signal });
}

/**
 * `GET /runs/:id` — one run, with its work order resolved.
 *
 * Returns `RunDetail`, not `RunSummary`: the detail endpoint carries
 * `checkCoverage` (#104) and the list endpoint deliberately does not. Typing
 * the two the same would let a panel that needs coverage be handed a list row
 * that can never have it.
 */
export async function getRun(
  id: string,
  signal?: AbortSignal,
): Promise<RunDetail> {
  return api.get<RunDetail>(`/runs/${encodeURIComponent(id)}`, { signal });
}

export interface RunEventsPage {
  items: RunEvent[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * `GET /runs/:id/events` — a run's normalized timeline, newest first.
 *
 * Paginated because `RunEvent` is the highest-volume table in the schema: a
 * single run emits a progress event per tool call plus heartbeats, so an
 * unpaginated timeline would not survive a real run (#83).
 */
export async function getRunEvents(
  id: string,
  params: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
): Promise<RunEventsPage> {
  const searchParams = new URLSearchParams();
  if (params.page) searchParams.set('page', String(params.page));
  if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));
  const query = searchParams.toString();

  return api.get<RunEventsPage>(
    `/runs/${encodeURIComponent(id)}/events${query ? `?${query}` : ''}`,
    { signal },
  );
}

/** `GET /queue` — work orders waiting to dispatch, in dispatch order. */
export async function getRunQueue(
  params?: { limit?: number },
  signal?: AbortSignal,
): Promise<QueueEntry[]> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', String(params.limit));
  const query = searchParams.toString();

  return api.get<QueueEntry[]>(query ? `/queue?${query}` : '/queue', {
    signal,
  });
}

/**
 * `GET /events` — the normalized event floor (VISION §9), newest first.
 *
 * `limit` defaults to 20 because this feeds a dashboard panel, not an audit
 * view. The full history belongs on a run's own page, where it can be paged.
 */
export async function getActivityFeed(
  params?: { limit?: number },
  signal?: AbortSignal,
): Promise<RunEvent[]> {
  // `pageSize`, not `limit`: the endpoint paginates like every other list in
  // this API. The panel wants the newest N and nothing else, so the page size
  // IS the limit here and the envelope is unwrapped for the caller — a
  // dashboard panel has no pager and no use for `total`.
  const searchParams = new URLSearchParams({
    pageSize: String(params?.limit ?? 20),
  });

  const page = await api.get<{ items: RunEvent[]; total: number }>(
    `/events?${searchParams}`,
    { signal },
  );
  return page.items;
}

// ---------------------------------------------------------------------------
// Quota: the live gauge (#231) and the history behind it (#476)
// ---------------------------------------------------------------------------
//
// Three reads, gated identically on `runs:read` by `QuotaController` — the
// consumption figures are sums over run events, and gating an aggregate more
// loosely than its rows would let somebody total up runs they cannot open.
//
// They stay three functions because they are three different kinds of fact and
// the API serves them from three routes. `GET /quota` is a GAUGE with no
// memory; `GET /quota/events` is what happened to a run inside a window; `GET
// /quota/windows` is what happened to the window itself, including the windows
// that hit the wall with nothing dispatched against them. Neither history half
// subsumes the other — the API's own DTO says so at length — and a client that
// merged them would have to decide which of the two facts to drop.

/** `GET /quota` — every runner with a live window, and which one binds. */
export async function getQuotaSummary(
  signal?: AbortSignal,
): Promise<QuotaSummary> {
  return api.get<QuotaSummary>('/quota', { signal });
}

export interface QuotaEventsPage {
  items: RateLimitEpisode[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * `GET /quota/events` — rate-limit episodes, newest first.
 *
 * Only parameters the endpoint actually honours are sent, the rule
 * `userListColumns.tsx` states: a control the API cannot answer looks live and
 * does nothing. Read off `quotaEventsQuerySchema` — `page`, `pageSize`
 * (max 100), `since`, `until`, `runnerKey`, `reason`, and NOTHING else. There
 * is no `sort`: the order is fixed at newest-first, so declaring a sort union
 * here would be fabricating a contract.
 *
 * `since` and `until` must be full ISO instants (`z.iso.datetime()`), not
 * dates — see `components/quota/quotaFormat.ts`, which is where a range
 * selection becomes one.
 */
export async function getQuotaEvents(
  params: {
    page?: number;
    pageSize?: number;
    since?: string;
    until?: string;
    runnerKey?: string;
    reason?: RateLimitReason;
  } = {},
  signal?: AbortSignal,
): Promise<QuotaEventsPage> {
  const searchParams = new URLSearchParams();
  if (params.page) searchParams.set('page', String(params.page));
  if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params.since) searchParams.set('since', params.since);
  if (params.until) searchParams.set('until', params.until);
  if (params.runnerKey) searchParams.set('runnerKey', params.runnerKey);
  if (params.reason) searchParams.set('reason', params.reason);

  const query = searchParams.toString();
  return api.get<QuotaEventsPage>(
    query ? `/quota/events?${query}` : '/quota/events',
    { signal },
  );
}

export interface QuotaWindowsPage {
  items: ExhaustedWindow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * `GET /quota/windows` — windows that ever reached `exhausted`, newest reset
 * first.
 *
 * Takes no `reason`, and that is not an omission: a window has none. Its
 * `since`/`until` are also a different question from the episodes' — they test
 * OVERLAP against the window's observation span, so a window first sighted
 * before the range and still exhausted inside it is returned. The same two
 * values therefore mean slightly different things on the two calls, which is
 * why they are two functions rather than one with a shared query object.
 */
export async function getQuotaWindows(
  params: {
    page?: number;
    pageSize?: number;
    since?: string;
    until?: string;
    runnerKey?: string;
  } = {},
  signal?: AbortSignal,
): Promise<QuotaWindowsPage> {
  const searchParams = new URLSearchParams();
  if (params.page) searchParams.set('page', String(params.page));
  if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params.since) searchParams.set('since', params.since);
  if (params.until) searchParams.set('until', params.until);
  if (params.runnerKey) searchParams.set('runnerKey', params.runnerKey);

  const query = searchParams.toString();
  return api.get<QuotaWindowsPage>(
    query ? `/quota/windows?${query}` : '/quota/windows',
    { signal },
  );
}

// ---------------------------------------------------------------------------
// Notifications (epic #17, issue #58)
// ---------------------------------------------------------------------------

export async function getNotificationConfig(): Promise<NotificationConfig> {
  return api.get<NotificationConfig>('/notifications/config');
}

export async function getPushSubscriptions(): Promise<{
  items: PushSubscriptionRecord[];
  total: number;
}> {
  return api.get<{ items: PushSubscriptionRecord[]; total: number }>(
    '/notifications/subscriptions',
  );
}

export async function createPushSubscription(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}): Promise<PushSubscriptionRecord> {
  return api.post<PushSubscriptionRecord>(
    '/notifications/subscriptions',
    input,
  );
}

export async function deletePushSubscription(id: string): Promise<void> {
  await api.delete<void>(`/notifications/subscriptions/${id}`);
}

// ---------------------------------------------------------------------------
// Approvals (epic #22, issue #98, VISION §8)
// ---------------------------------------------------------------------------

/**
 * `GET /approvals` — everything still waiting on a person, OLDEST FIRST.
 *
 * The order is the server's answer and is never re-sorted here or by the page:
 * the oldest open approval is the one that has been ignored longest, which is
 * the ordering the queue exists to surface. The endpoint declares no `sort`
 * parameter for the same reason, so the table offers no sortable header.
 *
 * `actionClass` is deliberately NOT offered by the cockpit's filter surface:
 * the accepted values are the ADR-0011 registry ids, no endpoint exposes that
 * registry to a browser, and a second copy of the taxonomy in this app is
 * exactly the drift the registry exists to prevent. `status` is safe because
 * its two members are the closed set the API's own enum pins.
 *
 * Every row carries `actionClassTitle`, the registry title joined on by the
 * API, so the queue can name a class in words without this app knowing the
 * taxonomy. It is null — never the raw id — for a class the registry does not
 * know, and the table renders `actionClassTitle ?? actionClass`.
 */
export async function getApprovals(
  params: {
    repositoryId?: string;
    actionClass?: string;
    status?: OpenApprovalStatus;
  } = {},
  signal?: AbortSignal,
): Promise<ApprovalListItem[]> {
  const searchParams = new URLSearchParams();
  if (params.repositoryId)
    searchParams.set('repositoryId', params.repositoryId);
  if (params.actionClass) searchParams.set('actionClass', params.actionClass);
  if (params.status) searchParams.set('status', params.status);

  const query = searchParams.toString();
  return api.get<ApprovalListItem[]>(
    query ? `/approvals?${query}` : '/approvals',
    { signal },
  );
}

/**
 * `GET /approvals/:id` — one approval, with the registry entry joined on.
 *
 * `actionClassEntry` is what makes the detail screen answerable from a phone:
 * the class `title` and the one-sentence `definition`, plus the
 * `autonomyEligible` flag that decides whether "Always approve this class" can
 * do anything at all.
 */
export async function getApproval(
  id: string,
  signal?: AbortSignal,
): Promise<ApprovalDetail> {
  return api.get<ApprovalDetail>(`/approvals/${encodeURIComponent(id)}`, {
    signal,
  });
}

/** `GET /approvals/rates` — per class, how often a human approves it. */
export async function getApprovalRates(
  days?: number,
  signal?: AbortSignal,
): Promise<ClassApprovalRates[]> {
  return api.get<ClassApprovalRates[]>(
    days === undefined ? '/approvals/rates' : `/approvals/rates?days=${days}`,
    { signal },
  );
}

/**
 * `POST /approvals/:id/decide` — VISION §8's "one tap from a phone".
 *
 * Authenticated with the ordinary session; the notification that deep-links
 * here carries no authority of its own. Throws `ApiError` on 403 (the
 * `alwaysApproveThisClass` refusal, where NOTHING was recorded), 409 (the
 * request is no longer open) and 404.
 */
export async function decideApproval(
  id: string,
  input: DecideApprovalInput,
): Promise<DecideApprovalResult> {
  return api.post<DecideApprovalResult>(
    `/approvals/${encodeURIComponent(id)}/decide`,
    input,
  );
}

/**
 * The `details` block the approval endpoints attach to a refusal.
 *
 * `HttpExceptionFilter` overwrites the envelope's `code` from the status, so
 * the discriminator the cockpit branches on travels in `details.reason` —
 * which is why this reads `details` and not `ApiError.code`.
 */
export interface ApprovalErrorDetails {
  reason?: string;
  /**
   * Explicit on the 403, and `false` there.
   *
   * The whole request is refused when `alwaysApproveThisClass` is set without
   * `trust:grant` — the single verdict is NOT applied — and this field exists
   * so a client never has to infer that from a status code.
   */
  decisionApplied?: boolean;
  approvalId?: string;
  requiredPermission?: string;
  status?: string;
  decidedVia?: string | null;
  decidedAt?: string | null;
  decidedById?: string | null;
}

/** Reads the approval `details` block off an `ApiError`, if it has one. */
export function approvalErrorDetails(error: unknown): ApprovalErrorDetails {
  if (!(error instanceof ApiError)) return {};
  const details = error.details;
  if (typeof details !== 'object' || details === null) return {};
  return details as ApprovalErrorDetails;
}

// ---------------------------------------------------------------------------
// Trust grants and the promotion ladder (epic #22, issue #101, VISION §7, §8)
// ---------------------------------------------------------------------------

/**
 * `GET /trust/grants` — what may currently run unattended, and on what terms.
 *
 * Newest first, and the order is the server's. Every row carries all four
 * VISION §8 attributes plus the derived headroom fields the cockpit renders:
 * `remainingBudgetUsd`, `budgetHeadroomFraction`, `msUntilExpiry`,
 * `failureRate`, `nearExpiry` and `nearBudget`. Those are computed server-side
 * on purpose and must NOT be recomputed here — two independent versions of
 * `remaining / ceiling` is how a renewal banner and a budget bar end up
 * disagreeing on one screen.
 *
 * `includeEnded` defaults to false server-side, so it is sent only when the
 * caller asked for it. An explicit `status` WINS over it: `status=revoked`
 * returns revoked grants whether or not the flag is set.
 */
export async function getTrustGrants(
  params: TrustGrantFilters = {},
  signal?: AbortSignal,
): Promise<TrustGrantListItem[]> {
  const searchParams = new URLSearchParams();
  if (params.repositoryId)
    searchParams.set('repositoryId', params.repositoryId);
  if (params.actionClass) searchParams.set('actionClass', params.actionClass);
  if (params.status) searchParams.set('status', params.status);
  // Sent as the literal word rather than via `z.coerce.boolean()`'s trap: the
  // API parses `includeEnded` with `z.stringbool()`, for which "false" really
  // is false.
  if (params.includeEnded) searchParams.set('includeEnded', 'true');

  const query = searchParams.toString();
  return api.get<TrustGrantListItem[]>(
    query ? `/trust/grants?${query}` : '/trust/grants',
    { signal },
  );
}

/**
 * `GET /trust/grants/:id` — one grant, with two joins.
 *
 * `actionClassEntry` is the ADR-0011 registry entry, so an operator deciding
 * whether to revoke can see WHAT they would be switching off rather than a
 * class id. It is null when the registry does not know the class, which is a
 * real case rather than a defensive one: a grant outlives edits to the
 * taxonomy. `renewedBy` is the forward half of the renewal chain.
 */
export async function getTrustGrant(
  id: string,
  signal?: AbortSignal,
): Promise<TrustGrantDetail> {
  return api.get<TrustGrantDetail>(`/trust/grants/${encodeURIComponent(id)}`, {
    signal,
  });
}

/**
 * `DELETE /trust/grants/:id` — revoke, immediately and permanently.
 *
 * Returns the ENDED grant rather than 204, so the caller can render the
 * terminal state without a follow-up read that would race the next sweep.
 * Throws `ApiError` with `details.reason === 'already-ended'` on 409, where
 * NOTHING was changed and the original end reason stands.
 *
 * The note travels as a request body on a DELETE, which `ApiService.request`
 * supports because `RequestOptions extends RequestInit` — and the body is
 * omitted entirely when there is no note, because the API's schema defaults to
 * `{}` precisely so that revoking without explaining yourself is not a 400.
 * Revocation is the safe direction and must never be harder than granting.
 */
export async function revokeTrustGrant(
  id: string,
  note?: string,
): Promise<TrustGrantDetail> {
  const trimmed = note?.trim();
  return api.delete<TrustGrantDetail>(
    `/trust/grants/${encodeURIComponent(id)}`,
    trimmed ? { body: JSON.stringify({ note: trimmed }) } : {},
  );
}

/**
 * `POST /trust/grants` — grant trust for one class in one repository.
 *
 * THREE FIELDS, and the omissions are the design. The schema is `.strict()`,
 * so sending `expiresAt`, `budgetCeilingUsd`, `maxFailureRate`,
 * `maxCostPerActionUsd` or `minActionsBeforeAutoRevoke` is a 400 naming the
 * field — the four VISION §8 attributes are attached by the server and are not
 * caller input. This signature is narrow for the same reason: a widened one
 * here would make the refusal look like a bug in the client rather than the
 * contract it is.
 */
export async function createTrustGrant(input: {
  actionClass: string;
  repositoryId: string;
  note?: string;
}): Promise<TrustGrantDetail> {
  return api.post<TrustGrantDetail>('/trust/grants', input);
}

/**
 * `GET /promotion/states` — the whole ladder, plus the switch above it.
 *
 * `enabled` is the flag that decides whether any rung on the screen is a live
 * conclusion. It DEFAULTS OFF, so false is the common case and every surface
 * that draws a rung has to say so.
 */
export async function getPromotionLadder(
  signal?: AbortSignal,
): Promise<PromotionLadder> {
  return api.get<PromotionLadder>('/promotion/states', { signal });
}

/** `GET /promotion/states/:actionClass` — one class, in the same envelope. */
export async function getPromotionState(
  actionClass: string,
  signal?: AbortSignal,
): Promise<PromotionStateDetail> {
  return api.get<PromotionStateDetail>(
    `/promotion/states/${encodeURIComponent(actionClass)}`,
    { signal },
  );
}

/**
 * `POST /promotion/states/:actionClass/demote` — take a class off the rung by
 * hand, and suspend the grants it authorized.
 *
 * The result's `grantsSuspended` is the DURABLE effect; `rungMayBeRestoredByLadder`
 * is the caveat that must be surfaced rather than swallowed. Throws `ApiError`
 * with `details.reason === 'not-promoted'` on 409.
 */
export async function demoteActionClass(
  actionClass: string,
  note?: string,
): Promise<ManualDemotionResult> {
  const trimmed = note?.trim();
  return api.post<ManualDemotionResult>(
    `/promotion/states/${encodeURIComponent(actionClass)}/demote`,
    trimmed ? { note: trimmed } : undefined,
  );
}

/**
 * The `details` block the trust and promotion endpoints attach to a refusal.
 *
 * `HttpExceptionFilter` derives the envelope's `code` from the status, so the
 * discriminator a client branches on travels in `details.reason` — the same
 * place the approvals conflict puts its own, and the reason this reads
 * `details` rather than `ApiError.code`.
 */
export interface TrustErrorDetails {
  /** `already-ended` on a grant, `not-promoted` on a class. */
  reason?: string;
  grantId?: string;
  status?: string;
  endReason?: string | null;
  endedAt?: string | null;
  actionClass?: string;
  rung?: string;
}

/** Reads the trust `details` block off an `ApiError`, if it has one. */
export function trustErrorDetails(error: unknown): TrustErrorDetails {
  if (!(error instanceof ApiError)) return {};
  const details = error.details;
  if (typeof details !== 'object' || details === null) return {};
  return details as TrustErrorDetails;
}

// ---------------------------------------------------------------------------
// The Control Center's operator settings (#348, epic #332)
// ---------------------------------------------------------------------------

/**
 * `GET /operator-settings` — the whole registry, resolved.
 *
 * Nothing is filtered or reshaped on the way through, deliberately. The
 * sections are generated from what this returns, so a key added to
 * `operator-settings.registry.ts` reaches the screen without a frontend
 * change; a client-side allowlist of known keys would put that promise back
 * where the epic took it from.
 */
export async function getOperatorSettings(
  signal?: AbortSignal,
): Promise<OperatorSettingsDocument> {
  return api.get<OperatorSettingsDocument>('/operator-settings', { signal });
}

/**
 * `PATCH /operator-settings` — the changed keys, and only those.
 *
 * The sparseness is a correctness requirement rather than an economy: an
 * absent row means "fall through to the environment", so a body carrying every
 * rendered key would materialise today's defaults into rows and freeze this
 * deployment against every later change to a default. `useOperatorSettings`
 * computes the diff; this function does not add to it.
 *
 * `If-Match` carries the document `revision` from the read the operator was
 * looking at, so a concurrent change answers 409 rather than being silently
 * overwritten. A null revision means the overlay never loaded — the header is
 * then omitted, since sending a number we do not have would be a lie about
 * what was read, and the API's own 409 for that case is the honest answer.
 */
export async function patchOperatorSettings(
  changes: OperatorSettingsPatch,
  revision: number | null,
): Promise<OperatorSettingsDocument> {
  return api.patch<OperatorSettingsDocument>('/operator-settings', changes, {
    headers:
      revision === null ? undefined : { 'If-Match': revision.toString() },
  });
}

// ---------------------------------------------------------------------------
// What the supervisor key can reach (#394, epic #391)
// ---------------------------------------------------------------------------

/**
 * `GET /operator-settings/supervisor-models` — the models one consumer's
 * configured key can actually reach, on the provider that consumer selects.
 *
 * **`consumer` is required here although the API defaults it** (#423). The
 * default exists so the route means what it meant before there was a second
 * consumer; a caller in this build always knows which of them it is asking
 * for, and one that omitted the parameter would silently read the
 * supervisor's provider while rendering somebody else's dropdown. The answer
 * echoes the consumer back, and callers file it under that echo rather than
 * under what they asked for — two lists are in flight at once and they must
 * not be able to land under each other.
 *
 * **This spends nothing.** A catalogue read bills no tokens on either vendor,
 * which is why it can be offered as a plain refresh next to a Test button that
 * deliberately makes one billed call. The response says so in `spendsTokens`
 * rather than leaving this layer to know it.
 *
 * **A failure resolves rather than rejecting.** `no_key`, `invalid_key`,
 * `wrong_provider`, `unreachable`, `refused` and `failed` all arrive as 200s
 * carrying `models: []`, because "the request failed" and "the request found a
 * failure" are the two things the endpoint exists to tell apart. Only a
 * genuinely broken request — a 403 from the permission gate, a 5xx — throws
 * `ApiError`, and the caller reports that as a request failure and not as a
 * verdict on anybody's credential.
 *
 * Both settings are read per request on the API side, so a provider or a key
 * saved a moment ago is the one this asks with.
 */
export async function getModelCatalog(
  consumer: string,
  signal?: AbortSignal,
): Promise<SupervisorModelCatalog> {
  const query = new URLSearchParams({ consumer });

  return api.get<SupervisorModelCatalog>(
    `/operator-settings/supervisor-models?${query.toString()}`,
    { signal },
  );
}

// ---------------------------------------------------------------------------
// The guided Claude sign-in (#386, epic #332)
// ---------------------------------------------------------------------------

/**
 * `POST /operator-settings/claude-auth/start` — begin a sign-in.
 *
 * **This blocks.** The API spawns `claude setup-token` on a pseudo-terminal
 * and does not answer until the CLI has printed its authorize URL — a few
 * seconds normally, forty-five at the ceiling. There is no earlier response
 * worth having: the URL is the only thing the screen can render, and a
 * two-phase "started, now poll" would put the same wait in the client with an
 * extra round trip on top. Callers must show a pending state that survives
 * three-quarters of a minute without looking frozen.
 *
 * Rejects with `ApiError`. A 409 means another sign-in is already live and its
 * message names the session to cancel; that message is shown as written,
 * because it carries an identifier this layer would only mangle.
 */
export async function startClaudeAuth(
  signal?: AbortSignal,
): Promise<ClaudeAuthSession> {
  return api.post<ClaudeAuthSession>(
    '/operator-settings/claude-auth/start',
    undefined,
    { signal },
  );
}

/**
 * `GET /operator-settings/claude-auth/:sessionId` — where a sign-in is now.
 *
 * The same shape every other route here answers. Rejects 404 for a session
 * this API has never held — which includes every session from before an API
 * restart, since these live in memory by design.
 */
export async function getClaudeAuthSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ClaudeAuthSession> {
  return api.get<ClaudeAuthSession>(
    `/operator-settings/claude-auth/${encodeURIComponent(sessionId)}`,
    { signal },
  );
}

/**
 * `POST /operator-settings/claude-auth/:sessionId/code` — hand over the code.
 *
 * **This blocks for as long as the vendor exchange takes**, up to ninety
 * seconds. It is the wait most likely to be mistaken for a hung screen, and
 * the one place a caller must say what is happening rather than spin.
 *
 * The response is the finished session and never the token: success is
 * `status: 'completed'` with `configured: true`, which is the whole of it.
 *
 * The code is sent exactly as given. Trimming happens in the API's own schema,
 * which also refuses an embedded newline rather than silently truncating at
 * it — a rule this layer must not pre-empt, since a client-side "fix" would
 * turn a refusal into a half-code written to a live terminal.
 */
export async function submitClaudeAuthCode(
  sessionId: string,
  code: string,
  signal?: AbortSignal,
): Promise<ClaudeAuthSession> {
  return api.post<ClaudeAuthSession>(
    `/operator-settings/claude-auth/${encodeURIComponent(sessionId)}/code`,
    { code },
    { signal },
  );
}

/**
 * `DELETE /operator-settings/claude-auth/:sessionId` — stop a sign-in.
 *
 * Kills the CLI process group. This is not cosmetic: a session abandoned
 * without it leaves a `claude` process holding a pseudo-terminal until the
 * ten-minute expiry, and a second sign-in cannot start until it goes. Safe to
 * call on a session that has already ended.
 */
export async function cancelClaudeAuth(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ClaudeAuthSession> {
  return api.delete<ClaudeAuthSession>(
    `/operator-settings/claude-auth/${encodeURIComponent(sessionId)}`,
    { signal },
  );
}

// ---------------------------------------------------------------------------
// Audit events (#351, epic #332)
// ---------------------------------------------------------------------------

/**
 * `GET /api/audit-events` — the audit log, newest first (#338, #351).
 *
 * Only the parameters `auditEventListQuerySchema` actually declares are sent.
 * `targetType` is the one History offers, because it is what separates "what
 * changed about my configuration" from every storage upload and role change in
 * the same table.
 *
 * No `sort` parameter exists on this endpoint: the order is `createdAt desc`
 * with an `id` tiebreaker, and `sortOrder` only flips it. A sortable column
 * here could therefore only re-order the page in the browser, which is why
 * `historyColumns.tsx` declares nothing sortable.
 *
 * The endpoint is gated on `system_settings:read`, the same permission the
 * Control Center route already requires — see the controller's header for why
 * it is that string and not a new `audit:read`.
 */
export async function getAuditEvents(
  params: {
    page?: number;
    pageSize?: number;
    targetType?: string;
    targetId?: string;
    action?: string;
    actorUserId?: string;
    since?: string;
    until?: string;
    sortOrder?: 'asc' | 'desc';
  } = {},
  signal?: AbortSignal,
): Promise<AuditEventsPage> {
  const searchParams = new URLSearchParams();
  if (params.page) searchParams.set('page', String(params.page));
  if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params.targetType) searchParams.set('targetType', params.targetType);
  if (params.targetId) searchParams.set('targetId', params.targetId);
  if (params.action) searchParams.set('action', params.action);
  if (params.actorUserId) searchParams.set('actorUserId', params.actorUserId);
  if (params.since) searchParams.set('since', params.since);
  if (params.until) searchParams.set('until', params.until);
  if (params.sortOrder) searchParams.set('sortOrder', params.sortOrder);

  const query = searchParams.toString();
  return api.get<AuditEventsPage>(
    query ? `/audit-events?${query}` : '/audit-events',
    { signal },
  );
}

// ---------------------------------------------------------------------------
// The Test buttons (#349, epic #332)
// ---------------------------------------------------------------------------

/**
 * What a probe call produced — which is not the same question as what the
 * probe found.
 *
 * `answered` carries the API's own `{ ok, detail, checkedAt, skipped }`
 * untouched, including `ok: false`, because a rejected credential is a finding
 * rather than a fault. `unreachable` is the other thing entirely: the call did
 * not produce a finding at all — no permission, no route, no network — and
 * the screen must not paint that as a failing credential. Telling an operator
 * their token is bad when the real problem is a 403 on the probe endpoint is
 * the mistake this split exists to make impossible.
 */
export type OperatorProbeOutcome =
  | { state: 'answered'; result: OperatorProbeResult }
  | {
      state: 'unreachable';
      detail: string;
      /** The HTTP status, when there was one. Null for a transport failure. */
      status: number | null;
    };

/**
 * `POST /operator-settings/probes/:probe` — does the configured thing work?
 *
 * Resolves for every outcome, like `probeRepositoryAccess`. A probe is
 * something an operator asks on purpose and gets an answer to; throwing would
 * make the button's failure mode "an exception somewhere" rather than a
 * sentence on the card next to it.
 *
 * The response is NOT reshaped. `ok`, `detail`, `checkedAt`, `skipped` and
 * `rateLimit` all reach the component as the API wrote them — a client-side
 * "helpful" default for `detail` would be this layer inventing a finding, and
 * a `checkedAt` filled in from the browser clock would be an observation
 * timestamped by something that did not observe anything.
 */
export async function runOperatorProbe(
  probe: OperatorProbeName,
  options: { repositoryId?: string; signal?: AbortSignal } = {},
): Promise<OperatorProbeOutcome> {
  const { repositoryId, signal } = options;

  try {
    const result = await api.post<OperatorProbeResult>(
      `/operator-settings/probes/${encodeURIComponent(probe)}`,
      // Always an object, even when there is nothing to say. The API's body is
      // optional in OpenAPI terms, but `ZodValidationPipe` is global and an
      // absent body reaches an object schema as `undefined` — which a
      // `z.object` rejects. `{}` satisfies it and means the same thing:
      // `github-repo` then asks about the first observed repository, which is
      // what an operator with one registered repository expects.
      { ...(repositoryId === undefined ? {} : { repositoryId }) },
      { signal },
    );

    return { state: 'answered', result };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 403) {
        return {
          state: 'unreachable',
          status: 403,
          detail:
            'This account may not run probes, so nothing here has been ' +
            'tested — which says nothing either way about the credential. ' +
            'Running one needs system_settings:write.',
        };
      }

      if (error.status === 404 || error.status === 501) {
        return {
          state: 'unreachable',
          status: error.status,
          detail:
            `This deployment's API does not know the ${probe} probe ` +
            `(${error.status}: ${error.message}). Nothing has tested this ` +
            'credential.',
        };
      }

      return {
        state: 'unreachable',
        status: error.status,
        detail: `The probe answered ${error.status}: ${error.message}`,
      };
    }

    return {
      state: 'unreachable',
      status: null,
      detail:
        error instanceof Error
          ? `The probe could not be called: ${error.message}`
          : 'The probe could not be called.',
    };
  }
}
