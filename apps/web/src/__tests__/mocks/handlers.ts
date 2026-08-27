import { http, HttpResponse } from 'msw';

import { costSummaryFixture } from './costSummary';
import { operatorSettingsFixture } from './operatorSettings';
import { supervisorModelCatalogFixture } from './supervisorModels';

// Use wildcard pattern to match relative URLs
const API_BASE = '*/api';

// Mock data
const mockUser = {
  id: 'test-user-id',
  email: 'test@example.com',
  displayName: 'Test User',
  profileImageUrl: null,
  roles: [{ name: 'viewer' }],
  permissions: ['user_settings:read', 'user_settings:write'],
  isActive: true,
  createdAt: new Date().toISOString(),
};

const mockUserSettings = {
  theme: 'system',
  profile: {
    displayName: null,
    useProviderImage: true,
    customImageUrl: null,
  },
  updatedAt: new Date().toISOString(),
  version: 1,
};

const mockSystemSettings = {
  ui: {
    allowUserThemeOverride: true,
  },
  features: {},
  updatedAt: new Date().toISOString(),
  updatedBy: null,
  version: 1,
};

/**
 * `GET /api/audit-events`, as the API really serialises it (#338, #351).
 *
 * The rows below are the SERVER's shape, not an echo of a request: the
 * envelope is `{ data: { items, total, page, pageSize, totalPages } }` from
 * `TransformInterceptor` plus the flat pagination the service returns, and
 * each `meta` is what `redactSettingsMeta` leaves behind — including the
 * detail that a masked value keeps its last four characters
 * (`maskSecret`, `REVEALED_SUFFIX_LENGTH`). A fixture that masked to a bare
 * `********` would let the UI pass a test it fails against the real API.
 */
export const mockAuditEvents = [
  {
    id: '00000000-0000-4000-8000-0000000000a1',
    action: 'operator_settings:set',
    targetType: 'operator_settings',
    targetId: 'github.token',
    actorUserId: 'admin-user-id',
    actor: {
      id: 'admin-user-id',
      email: 'admin@example.com',
      displayName: 'Admin User',
    },
    // `from` was null (no row yet) and masks to the bare mask; `to` is a
    // sealed token and keeps its last four characters.
    meta: {
      key: 'github.token',
      from: '********',
      to: '********Ly5Hs',
      fromSource: 'env',
      toSource: 'database',
    },
    createdAt: '2026-08-26T10:05:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-0000000000a2',
    action: 'operator_settings:set',
    targetType: 'operator_settings',
    targetId: 'dispatch.enabled',
    actorUserId: 'admin-user-id',
    actor: {
      id: 'admin-user-id',
      email: 'admin@example.com',
      displayName: 'Admin User',
    },
    meta: {
      key: 'dispatch.enabled',
      from: false,
      to: true,
      fromSource: 'default',
      toSource: 'database',
    },
    createdAt: '2026-08-26T10:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-0000000000a3',
    action: 'operator_settings:clear',
    targetType: 'operator_settings',
    targetId: 'runners.claudeCodeLocal.oauthToken',
    // A person did this and the account has since been deleted:
    // `onDelete: SetNull` on the relation, the id still on the row.
    actorUserId: 'deleted-user-id',
    actor: null,
    meta: {
      key: 'runners.claudeCodeLocal.oauthToken',
      from: '********pJ4c',
      to: '********',
      fromSource: 'database',
      toSource: 'env',
    },
    createdAt: '2026-08-26T09:30:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-0000000000a4',
    action: 'allowlist:add',
    targetType: 'allowed_email',
    targetId: '00000000-0000-4000-8000-0000000000b1',
    // Nothing human did it — a different fact from a deleted actor.
    actorUserId: null,
    actor: null,
    meta: { email: 'newcomer@example.com' },
    createdAt: '2026-08-25T08:00:00.000Z',
  },
];

const mockProviders = [{ name: 'google', authUrl: '/api/auth/google' }];

export const handlers = [
  // Auth endpoints
  http.get(`${API_BASE}/auth/providers`, () => {
    // Real API returns { providers: [...] } which gets unwrapped by api.ts
    return HttpResponse.json({ providers: mockProviders });
  }),

  http.get(`${API_BASE}/auth/me`, () => {
    return HttpResponse.json({ data: mockUser });
  }),

  http.post(`${API_BASE}/auth/logout`, () => {
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${API_BASE}/auth/refresh`, () => {
    return HttpResponse.json({
      accessToken: 'new-mock-token',
      expiresIn: 900,
    });
  }),

  // User settings endpoints
  http.get(`${API_BASE}/user-settings`, () => {
    return HttpResponse.json({ data: mockUserSettings });
  }),

  http.put(`${API_BASE}/user-settings`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        ...mockUserSettings,
        ...body,
        version: mockUserSettings.version + 1,
        updatedAt: new Date().toISOString(),
      },
    });
  }),

  http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        ...mockUserSettings,
        ...body,
        version: mockUserSettings.version + 1,
        updatedAt: new Date().toISOString(),
      },
    });
  }),

  // System settings endpoints
  http.get(`${API_BASE}/system-settings`, () => {
    return HttpResponse.json({ data: mockSystemSettings });
  }),

  http.patch(`${API_BASE}/system-settings`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        ...mockSystemSettings,
        ...body,
        version: mockSystemSettings.version + 1,
        updatedAt: new Date().toISOString(),
      },
    });
  }),

  http.put(`${API_BASE}/system-settings`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        ...body,
        updatedAt: new Date().toISOString(),
        updatedBy: null,
        version: 1,
      },
    });
  }),

  // Users endpoints
  http.get(`${API_BASE}/users`, () => {
    return HttpResponse.json({
      items: [
        {
          id: mockUser.id,
          email: mockUser.email,
          displayName: mockUser.displayName,
          providerDisplayName: 'Test User (Provider)',
          profileImageUrl: mockUser.profileImageUrl,
          providerProfileImageUrl: null,
          isActive: mockUser.isActive,
          roles: mockUser.roles.map((r) => r.name),
          createdAt: mockUser.createdAt,
          updatedAt: mockUser.createdAt,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
    });
  }),

  http.get(`${API_BASE}/users/:id`, ({ params }) => {
    if (params.id === mockUser.id) {
      return HttpResponse.json({ data: mockUser });
    }
    return new HttpResponse(null, { status: 404 });
  }),

  http.patch(`${API_BASE}/users/:id`, async ({ params, request }) => {
    if (params.id === mockUser.id) {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        id: mockUser.id,
        email: mockUser.email,
        displayName:
          (body.displayName as string | null) ?? mockUser.displayName,
        providerDisplayName: 'Test User (Provider)',
        profileImageUrl: mockUser.profileImageUrl,
        providerProfileImageUrl: null,
        isActive:
          body.isActive !== undefined
            ? (body.isActive as boolean)
            : mockUser.isActive,
        roles: mockUser.roles.map((r) => r.name),
        createdAt: mockUser.createdAt,
        updatedAt: new Date().toISOString(),
      });
    }
    return HttpResponse.json({ message: 'Not found' }, { status: 404 });
  }),

  http.put(`${API_BASE}/users/:id/roles`, async ({ params, request }) => {
    if (params.id === mockUser.id) {
      const body = (await request.json()) as { roles: string[] };
      return HttpResponse.json({
        id: mockUser.id,
        email: mockUser.email,
        displayName: mockUser.displayName,
        providerDisplayName: 'Test User (Provider)',
        profileImageUrl: mockUser.profileImageUrl,
        providerProfileImageUrl: null,
        isActive: mockUser.isActive,
        roles: body.roles,
        createdAt: mockUser.createdAt,
        updatedAt: new Date().toISOString(),
      });
    }
    return HttpResponse.json({ message: 'Not found' }, { status: 404 });
  }),

  // Health endpoints
  /**
   * `GET /queue` — the dispatch queue (#80).
   *
   * Empty by default, which is the honest default for a test database with no
   * work orders in it: the queue panel's EMPTY state ("nothing is queued") and
   * its NOT-WIRED state ("dispatch does not exist yet") are opposite meanings,
   * and a fixture with rows in it would stop either being exercised. Tests that
   * need entries override this handler.
   */
  http.get(`${API_BASE}/queue`, () => {
    return HttpResponse.json({ data: [] });
  }),

  /**
   * `GET /runs` — the runs list, and the attention panel's source (#80).
   *
   * Paginated like every other list in this API, so the envelope carries
   * `items` and `total`; `services/api.ts` unwraps it for the panel. Empty by
   * default, which is the honest default: "nothing needs attention" and "the
   * watchdog does not exist" are opposite meanings and the dashboard renders
   * them differently.
   */
  http.get(`${API_BASE}/runs`, () => {
    return HttpResponse.json({
      data: { items: [], total: 0, page: 1, pageSize: 25 },
    });
  }),

  /**
   * `GET /metrics/summary` — the six VISION §10 metrics (#80).
   *
   * Every value null by default, which is not a placeholder: it is what the
   * endpoint really returns against an empty database, and four of the six
   * return null even against a full one. The tile renders null as an em dash
   * and still shows the metric's name and meaning.
   */
  http.get(`${API_BASE}/metrics/summary`, () => {
    const now = new Date().toISOString();
    const notMeasured = { value: null, trend: [] };
    return HttpResponse.json({
      data: {
        generatedAt: now,
        window: { from: now, to: now },
        metrics: {
          detectionLatency: notMeasured,
          deadTimePerDay: notMeasured,
          firstPassAcceptance: notMeasured,
          attemptsPerWorkOrder: notMeasured,
          costPerMergedPr: notMeasured,
          quotaBurn: notMeasured,
        },
      },
    });
  }),

  /**
   * `GET /events` — the activity feed (#80).
   *
   * Empty by default, and that is not a placeholder: "the factory is quiet"
   * and "the reconciler does not exist" are opposite meanings, and the
   * dashboard renders them differently. A fixture with rows would exercise
   * neither.
   */
  http.get(`${API_BASE}/events`, () => {
    return HttpResponse.json({
      data: { items: [], total: 0, page: 1, pageSize: 20 },
    });
  }),

  http.get(`${API_BASE}/health/live`, () => {
    return HttpResponse.json({
      data: {
        status: 'ok',
        timestamp: new Date().toISOString(),
      },
    });
  }),

  /**
   * `GET /health/ready` — Terminus's readiness payload, in its REAL shape.
   *
   * The previous fixture answered `{ checks: { database: 'ok' } }`, which no
   * endpoint has ever returned; the real one is `{ status, info, error,
   * details }` with one entry per indicator. That mattered from the moment the
   * Control Center started reading `info.fleet` for the readiness chain
   * (#347) — a fixture in an invented shape can only test invented behaviour.
   *
   * The values are the ones `docs/RUNBOOK-enable-claude-code-local.md` records
   * verbatim from the reference deployment after the epic #324 rebuild and
   * BEFORE any flag was flipped: `available: true` beside `enabled: false`.
   * That is the divergence the whole screen exists to show, so it is the
   * honest default for a deployment that has just been stood up.
   */
  http.get(`${API_BASE}/health/ready`, () => {
    const fleet = {
      status: 'up',
      checked: true,
      registered: 1,
      routable: 1,
      enabled: 0,
      dispatchable: 0,
      checkedAt: new Date().toISOString(),
      runners: [
        {
          key: 'claude-code-local',
          version: '2.1.246',
          enabled: false,
          available: true,
          maxConcurrency: 2,
        },
      ],
      message:
        'All 1 registered runner(s) are disabled. Nothing will be dispatched ' +
        'until one is switched on — this is a configuration choice, not a ' +
        'failure.',
    };

    return HttpResponse.json({
      data: {
        status: 'ok',
        // `info` holds the indicators that are up and `details` holds all of
        // them. Both are sent, because the client reads `info` first and falls
        // back — and a fixture with only one of them could not exercise that.
        info: { database: { status: 'up' }, fleet },
        error: {},
        details: { database: { status: 'up' }, fleet },
        timestamp: new Date().toISOString(),
      },
    });
  }),

  /**
   * `GET /repositories/available` — the picker's listing (#401).
   *
   * DECLARED BEFORE `GET /repositories`, mirroring the controller, where the
   * literal route has to precede `:id` or be swallowed by it.
   *
   * `no_credential` by default, with `reachable: 0` — the state a deployment
   * that has not configured a GitHub token is actually in, and a 200 rather
   * than an error because that is how the endpoint answers every finding.
   */
  http.get(`${API_BASE}/repositories/available`, ({ request }) => {
    const url = new URL(request.url);

    return HttpResponse.json({
      data: {
        status: 'no_credential',
        detail:
          'No GitHub credential is configured, so there is nothing to list ' +
          'yet. Set `github.token` to a fine-grained personal access token ' +
          'granted access to the repositories Opifex should watch, then list ' +
          'again.',
        repositories: [],
        page: Number(url.searchParams.get('page') ?? '1'),
        pageSize: Number(url.searchParams.get('pageSize') ?? '25'),
        total: 0,
        totalPages: 0,
        reachable: 0,
        search: url.searchParams.get('search'),
        truncated: false,
        checkedAt: new Date().toISOString(),
      },
    });
  }),

  /**
   * `GET /repositories` — honours the two boolean filters the endpoint really
   * does, so the readiness chain's "how many may be dispatched into" question
   * gets a different answer from its "how many are registered" one.
   *
   * Empty by default: a deployment with nothing registered is the state an
   * operator opening the Control Center for the first time is actually in.
   */
  http.get(`${API_BASE}/repositories`, ({ request }) => {
    const url = new URL(request.url);
    const pageSize = Number(url.searchParams.get('pageSize') ?? '25');

    return HttpResponse.json({
      data: { items: [], total: 0, page: 1, pageSize },
    });
  }),

  /**
   * `GET /projects` — the project list (#404, epic #403).
   *
   * Empty by default, and that is the state every deployment is in until
   * somebody creates one: `Project` was modelled and never built, so no
   * project exists anywhere and every repository has `projectId: null`. A
   * fixture that invented two projects would let the unassigned bucket — the
   * one #406 has to keep first-class — go untested by default.
   *
   * Flat pagination with `totalPages`, which is what `ProjectsService`
   * returns through `TransformInterceptor`.
   */
  http.get(`${API_BASE}/projects`, ({ request }) => {
    const url = new URL(request.url);
    const pageSize = Number(url.searchParams.get('pageSize') ?? '25');

    return HttpResponse.json({
      data: { items: [], total: 0, page: 1, pageSize, totalPages: 0 },
    });
  }),

  /**
   * `GET /work-orders` — asked by the stand-down dialog for one number.
   *
   * Zero by default: nothing has run in a deployment whose repository list is
   * also empty, and answering anything else would make de-registering
   * un-offerable in every test that did not override this.
   */
  http.get(`${API_BASE}/work-orders`, ({ request }) => {
    const url = new URL(request.url);
    const pageSize = Number(url.searchParams.get('pageSize') ?? '25');

    return HttpResponse.json({
      data: { items: [], total: 0, page: 1, pageSize, totalPages: 0 },
    });
  }),

  /**
   * The audit log (#338). Filters and pages on the SERVER, like the endpoint,
   * so a test that changes the filter is testing the same contract the real
   * API offers rather than a client-side approximation.
   */
  http.get(`${API_BASE}/audit-events`, ({ request }) => {
    const url = new URL(request.url);
    const targetType = url.searchParams.get('targetType');
    const page = Number(url.searchParams.get('page') ?? '1');
    const pageSize = Number(url.searchParams.get('pageSize') ?? '20');

    const matching = targetType
      ? mockAuditEvents.filter((event) => event.targetType === targetType)
      : mockAuditEvents;

    return HttpResponse.json({
      data: {
        items: matching.slice((page - 1) * pageSize, page * pageSize),
        total: matching.length,
        page,
        pageSize,
        totalPages: Math.ceil(matching.length / pageSize),
      },
      meta: { timestamp: new Date().toISOString() },
    });
  }),

  // Device Authorization endpoints
  http.get(`${API_BASE}/auth/device/activate`, ({ request }) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');

    // Default success response
    return HttpResponse.json({
      data: {
        userCode: code || 'ABCD-1234',
        clientInfo: {
          deviceName: 'My Smart TV',
          userAgent: 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
          ipAddress: '192.168.1.100',
        },
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    });
  }),

  /**
   * `GET /api/operator-settings` — the Control Center's Configuration section
   * (#348, epic #332).
   *
   * A subset of the real registry, in the real response shape. See
   * `mocks/operatorSettings.ts` for which branches it was chosen to cover.
   */
  http.get(`${API_BASE}/operator-settings`, () =>
    HttpResponse.json({ data: operatorSettingsFixture() }),
  ),

  /**
   * `PATCH /api/operator-settings` — answers with the registry re-resolved,
   * as the real endpoint does, with the revision advanced.
   *
   * It deliberately does NOT apply the body: a test that wants to know what
   * was sent asserts on the request, and a fixture that pretended to resolve a
   * write would be asserting against its own simulation of the API rather than
   * against the API's contract.
   */
  http.patch(`${API_BASE}/operator-settings`, () =>
    HttpResponse.json({ data: operatorSettingsFixture({ revision: 8 }) }),
  ),

  /**
   * `GET /api/operator-settings/supervisor-models` — what the configured key
   * can reach (#393, #394, epic #391).
   *
   * Registered BEFORE the `PATCH` above would ever matter and after the plain
   * `GET /operator-settings`, because MSW matches in order and this is a
   * longer path under the same prefix.
   *
   * A failure on this endpoint is a 200 carrying a `status`, so there is no
   * error-shaped default to choose here: the default is a provider that
   * answered.
   */
  http.get(`${API_BASE}/operator-settings/supervisor-models`, () =>
    HttpResponse.json({ data: supervisorModelCatalogFixture() }),
  ),

  /**
   * `GET /api/cost/summary` — read by the Credentials section for
   * `ceiling`, the one place spend is tallied over the ceiling's own window
   * (#349, epic #332). Requires `runs:read` on the real API, which is a
   * different permission from the one that opens the Control Center.
   */
  http.get(`${API_BASE}/cost/summary`, () =>
    HttpResponse.json({ data: costSummaryFixture() }),
  ),

  http.post(`${API_BASE}/auth/device/authorize`, async ({ request }) => {
    const body = (await request.json()) as {
      userCode: string;
      approve: boolean;
    };

    return HttpResponse.json({
      data: {
        success: body.approve,
        message: body.approve
          ? 'Device authorized successfully!'
          : 'Device access denied.',
      },
    });
  }),
];
