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
  MetricsSummary,
  QueueEntry,
  RunEvent,
  RunStatus,
  RunSummary,
  WorkOrderDetail,
} from '../types/cockpit';

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
// ⚠️ NONE OF THESE FOUR ENDPOINTS EXIST IN `apps/api` TODAY. They are declared
// here anyway, and that is a deliberate choice rather than an oversight:
//
//  - The typed boundary is where a response shape is asserted. Writing these
//    now means the hooks, the panels and their tests are built against
//    `RunSummary` rather than against `any`, and the day the endpoint lands the
//    only thing that changes is a `false -> true` in `config/cockpitApi.ts`.
//  - Each one has an MSW-backed test, so the request path, the query string and
//    the `{ data }` unwrapping are verified against a stand-in server exactly
//    the way `getUsers` is. That test is what makes the declaration a
//    specification of the endpoint rather than a guess about it.
//
// What stops them from being CALLED is `COCKPIT_ENDPOINTS[…].available`, which
// every cockpit hook reads into `usePolledResource`'s `enabled`. Nothing here
// is reachable from the running app until that flips. The paths below and the
// paths in that registry must stay in step — the registry is the human-readable
// half, these are the executable half.
//
// There are no `sortBy` unions here (contrast `UserSortField` above, which
// mirrors a real zod enum in `apps/api`). Inventing one would be fabricating a
// contract: these get their sort enums from the controllers' query DTOs when
// those DTOs are written.
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

/** `GET /runs/:id` — one run, with its work order resolved. */
export async function getRun(
  id: string,
  signal?: AbortSignal,
): Promise<RunSummary> {
  return api.get<RunSummary>(`/runs/${encodeURIComponent(id)}`, { signal });
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
