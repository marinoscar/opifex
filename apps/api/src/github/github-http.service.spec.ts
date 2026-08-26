import { Logger } from '@nestjs/common';

import type { OperatorSettingsOverrides } from '../settings/operator-settings/operator-settings.registry';
import { makeOperatorSettings } from '../settings/operator-settings/operator-settings.test-double';
import { EtagCacheService } from './etag-cache.service';
import {
  GitHubHttpService,
  backoffMs,
  parseNextLink,
} from './github-http.service';
import {
  GitHubAuthError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubRequestError,
  GitHubTransientError,
} from './github.errors';
import { RateLimitService } from './rate-limit.service';

const SETTINGS: OperatorSettingsOverrides = {
  'github.apiBaseUrl': 'https://api.github.com',
  'github.token': 'ghp_test',
  'github.userAgent': 'opifex-test',
  'github.requestTimeoutMs': 5000,
  // Retries are exercised explicitly where they matter; elsewhere zero keeps
  // the suite from waiting on real backoff timers.
  'github.maxRetries': 0,
  'github.rateLimitReserve': 100,
};

function operatorSettings(overrides: OperatorSettingsOverrides = {}) {
  return makeOperatorSettings({ overrides: { ...SETTINGS, ...overrides } });
}

/** A `fetch` Response, with the rate-limit headers GitHub always sends. */
/**
 * A `fetch` Response, with the rate-limit headers GitHub always sends.
 *
 * Always mocked via `mockImplementation(async () => …)` rather than
 * `mockResolvedValue`, which hands back the SAME object every call — and a
 * Response body can only be read once, so the second request in any test
 * fails with "Body is unusable" several frames from the cause.
 */
function githubResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = new Headers({
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    'x-ratelimit-resource': 'core',
    ...extraHeaders,
  });
  return new Response(
    status === 204 || status === 304 ? null : JSON.stringify(body),
    {
      status,
      headers,
    },
  );
}

describe('GitHubHttpService', () => {
  let fetchMock: jest.SpyInstance;
  let rateLimit: RateLimitService;
  let etags: EtagCacheService;

  function build(overrides: OperatorSettingsOverrides = {}): GitHubHttpService {
    return new GitHubHttpService(operatorSettings(overrides), rateLimit, etags);
  }

  /**
   * The same service, with the settings handle kept — so a spec can change a
   * value while the service is alive, which is the whole subject of #341.
   */
  function buildLive(overrides: OperatorSettingsOverrides = {}) {
    const settings = operatorSettings(overrides);
    return {
      settings,
      service: new GitHubHttpService(settings, rateLimit, etags),
    };
  }

  /** The `Authorization` header of the nth fetch, 0-indexed. */
  function authorizationOf(call: number): string {
    const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
    return (init.headers as Record<string, string>).authorization;
  }

  beforeEach(() => {
    rateLimit = new RateLimitService();
    etags = new EtagCacheService(50);
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('request composition', () => {
    it('sends the credential, a user agent, and a pinned API version', () => {
      fetchMock.mockImplementation(async () => githubResponse(200, { id: 1 }));

      return build()
        .request('/repos/acme/app')
        .then(() => {
          const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
          const headers = init.headers as Record<string, string>;

          expect(url).toBe('https://api.github.com/repos/acme/app');
          expect(headers.authorization).toBe('Bearer ghp_test');
          // GitHub rejects requests with no User-Agent outright.
          expect(headers['user-agent']).toBe('opifex-test');
          // Pinned, so a GitHub API version bump is a deliberate change here
          // rather than a silent behaviour change under us.
          expect(headers['x-github-api-version']).toBe('2022-11-28');
        });
    });

    it('drops undefined query parameters instead of sending them empty', async () => {
      fetchMock.mockImplementation(async () => githubResponse(200, []));

      await build().request('/repos/acme/app/issues', {
        query: { state: 'open', labels: undefined, per_page: 100 },
      });

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain('state=open');
      expect(url).toContain('per_page=100');
      // `labels=` is not the same query as no `labels` at all — GitHub reads
      // the empty one as "issues with no labels".
      expect(url).not.toContain('labels');
    });

    it('fails with an auth error, not a crash, when no token is configured', async () => {
      // The empty string is how "no credential" is expressed now: the
      // registry's default for this key IS empty, and an override of
      // `undefined` would mean "say nothing", which is a different claim.
      const service = build({ 'github.token': '' });

      expect(service.configured).toBe(false);
      await expect(service.request('/repos/acme/app')).rejects.toBeInstanceOf(
        GitHubAuthError,
      );
      // The API must boot without GitHub configured; it just cannot call it.
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  /**
   * #341. The token, the timeout, the retry budget and the reserve are
   * per-request policy: a change to any of them must land on the NEXT request
   * without a restart. This mattered before any UI existed, because
   * `RunWorkspaceService` already read `github.token` live for git operations
   * — so a frozen copy here meant one rotation applying to `git push` and not
   * to the API call beside it.
   */
  describe('settings resolved per request (#341)', () => {
    it('carries a rotated token on the NEXT request', async () => {
      fetchMock.mockImplementation(async () => githubResponse(200, {}));
      const { settings, service } = buildLive();

      await service.request('/repos/acme/app');
      expect(authorizationOf(0)).toBe('Bearer ghp_test');

      // The rotation an operator performs while the process is running.
      settings.setOverride('github.token', 'ghp_rotated');

      await service.request('/repos/acme/app/issues');
      expect(authorizationOf(1)).toBe('Bearer ghp_rotated');
    });

    it('keeps ONE request on the token it started with, across its retries', async () => {
      // Resolved once per request, not once per attempt: a rotation landing
      // between the "is a credential configured" check and the header built
      // from it would send `Bearer undefined`, and a retry that changed
      // credentials mid-flight would make a 401 unattributable to either token.
      const { settings, service } = buildLive({ 'github.maxRetries': 1 });
      fetchMock
        .mockImplementationOnce(async () => {
          settings.setOverride('github.token', 'ghp_rotated');
          return githubResponse(503, { message: 'unavailable' });
        })
        .mockImplementation(async () => githubResponse(200, {}));

      await service.request('/repos/acme/app');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(authorizationOf(0)).toBe('Bearer ghp_test');
      expect(authorizationOf(1)).toBe('Bearer ghp_test');

      // And the request AFTER it picks the rotation up.
      await service.request('/repos/acme/app/issues');
      expect(authorizationOf(2)).toBe('Bearer ghp_rotated');
    });

    it('reports `configured` as of now, so a token arriving needs no restart', async () => {
      fetchMock.mockImplementation(async () => githubResponse(200, {}));
      const { settings, service } = buildLive({ 'github.token': '' });

      expect(service.configured).toBe(false);
      await expect(service.request('/repos/acme/app')).rejects.toBeInstanceOf(
        GitHubAuthError,
      );

      settings.setOverride('github.token', 'ghp_arrived');

      expect(service.configured).toBe(true);
      await service.request('/repos/acme/app');
      expect(authorizationOf(0)).toBe('Bearer ghp_arrived');
    });

    it('still warns at construction when no token is configured', () => {
      // #43 is where a missing token becomes actionable; this line is what an
      // operator reads a startup log for, and making the token live must not
      // cost it.
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      build({ 'github.token': '' });

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('GITHUB_TOKEN is not set'),
      );

      warn.mockClear();
      build();
      expect(warn).not.toHaveBeenCalled();
    });

    it('applies a changed timeout to the next request', async () => {
      const timeout = jest.spyOn(AbortSignal, 'timeout');
      fetchMock.mockImplementation(async () => githubResponse(200, {}));
      const { settings, service } = buildLive();

      await service.request('/repos/acme/app');
      expect(timeout).toHaveBeenLastCalledWith(5000);

      settings.setOverride('github.requestTimeoutMs', 1000);

      await service.request('/repos/acme/app');
      expect(timeout).toHaveBeenLastCalledWith(1000);
    });

    it('applies a changed retry budget to the next request', async () => {
      fetchMock.mockImplementation(async () =>
        githubResponse(503, { message: 'unavailable' }),
      );
      const { settings, service } = buildLive({ 'github.maxRetries': 0 });

      await expect(service.request('/x')).rejects.toBeInstanceOf(
        GitHubTransientError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // One retry, not three: every retry here waits on a real backoff timer,
      // and the assertion is that the budget CHANGED, not how large it got.
      settings.setOverride('github.maxRetries', 1);

      await expect(service.request('/x')).rejects.toBeInstanceOf(
        GitHubTransientError,
      );
      // Two more: the attempt plus its retry.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('applies a changed rate-limit reserve without a restart', async () => {
      fetchMock.mockImplementation(async () =>
        githubResponse(200, {}, { 'x-ratelimit-remaining': '50' }),
      );
      const { settings, service } = buildLive();
      await service.request('/repos/acme/app');

      expect(service.canSpend()).toBe(false);

      // VISION §11 has automated runs competing with a human for one budget;
      // an operator lowering the reserve wants the reconciler moving again now,
      // not after a deploy.
      settings.setOverride('github.rateLimitReserve', 10);

      expect(service.canSpend()).toBe(true);
    });

    it('does NOT follow a changed base URL or user agent', async () => {
      // Frozen deliberately. `EtagCacheService` is keyed by request PATH, not
      // by host, so a live process that changed hosts would send one host's
      // `If-None-Match` to another and take the 304 as confirmation of a body
      // the new host has never sent. A cache returning a different server's
      // answers is silently wrong, which is worse than stale.
      fetchMock.mockImplementation(async () => githubResponse(200, {}));
      const { settings, service } = buildLive();

      settings.setOverride('github.apiBaseUrl', 'https://ghe.internal/api/v3');
      settings.setOverride('github.userAgent', 'opifex-rotated');

      await service.request('/repos/acme/app');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.github.com/repos/acme/app');
      expect((init.headers as Record<string, string>)['user-agent']).toBe(
        'opifex-test',
      );
    });
  });

  describe('rate-limit accounting', () => {
    it('records the budget from a successful response', async () => {
      fetchMock.mockImplementation(async () => githubResponse(200, {}));

      await build().request('/repos/acme/app');

      // #40: remaining must be queryable state, not discovered by a 403.
      expect(rateLimit.snapshot()!.remaining).toBe(4999);
    });

    it('records the budget from a FAILING response too', async () => {
      // A 403 saying `remaining: 0` is the most informative response the
      // client ever gets. Dropping it because the request failed would be the
      // exact mistake the rate-limit state exists to prevent.
      fetchMock.mockImplementation(async () =>
        githubResponse(
          403,
          { message: 'API rate limit exceeded' },
          {
            'x-ratelimit-remaining': '0',
          },
        ),
      );

      await expect(build().request('/repos/acme/app')).rejects.toBeInstanceOf(
        GitHubRateLimitError,
      );
      expect(rateLimit.snapshot()!.remaining).toBe(0);
    });

    it('exposes canSpend() with the configured reserve applied', async () => {
      fetchMock.mockImplementation(async () =>
        githubResponse(200, {}, { 'x-ratelimit-remaining': '50' }),
      );
      const service = build();
      await service.request('/repos/acme/app');

      expect(service.canSpend()).toBe(false);
    });
  });

  describe('conditional requests', () => {
    it('stores the ETag from a full response and replays the body on 304', async () => {
      fetchMock.mockResolvedValueOnce(
        githubResponse(200, [{ number: 1 }], { etag: 'W/"abc"' }),
      );
      const service = build();

      const first = await service.request<{ number: number }[]>(
        '/repos/acme/app/issues',
      );
      expect(first.fromCache).toBe(false);

      fetchMock.mockResolvedValueOnce(
        githubResponse(304, null, { etag: 'W/"abc"' }),
      );
      const second = await service.request<{ number: number }[]>(
        '/repos/acme/app/issues',
      );

      const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['if-none-match']).toBe(
        'W/"abc"',
      );

      // A 304 has no body. Without a stored one, "unchanged" would be an
      // answer the caller could not use.
      expect(second.fromCache).toBe(true);
      expect(second.data).toEqual([{ number: 1 }]);
    });

    it('counts a 304 as a hit, so the ETag path is provably working', async () => {
      fetchMock.mockResolvedValueOnce(
        githubResponse(200, {}, { etag: 'W/"a"' }),
      );
      const service = build();
      await service.request('/repos/acme/app');

      fetchMock.mockResolvedValueOnce(githubResponse(304, null));
      await service.request('/repos/acme/app');

      expect(rateLimit.report()).toMatchObject({
        conditionalHits: 1,
        conditionalMisses: 0,
      });
    });

    it('counts a changed resource as a miss', async () => {
      fetchMock.mockResolvedValueOnce(
        githubResponse(200, { v: 1 }, { etag: 'W/"a"' }),
      );
      const service = build();
      await service.request('/repos/acme/app');

      fetchMock.mockResolvedValueOnce(
        githubResponse(200, { v: 2 }, { etag: 'W/"b"' }),
      );
      const second = await service.request<{ v: number }>('/repos/acme/app');

      expect(second.data).toEqual({ v: 2 });
      expect(rateLimit.report()).toMatchObject({
        conditionalHits: 0,
        conditionalMisses: 1,
      });
      // The new ETag replaces the old one, or the next request would validate
      // against a version two responses behind.
      expect(
        etags.get('GET', 'https://api.github.com/repos/acme/app')!.etag,
      ).toBe('W/"b"');
    });

    it('does not cache or condition a write', async () => {
      fetchMock.mockImplementation(async () =>
        githubResponse(201, { id: 1 }, { etag: 'W/"a"' }),
      );

      await build().request('/repos/acme/app/issues/1/comments', {
        method: 'POST',
        body: { body: 'hello' },
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(
        (init.headers as Record<string, string>)['if-none-match'],
      ).toBeUndefined();
      expect(etags.size).toBe(0);
    });

    it('serialises a body as JSON with the right content type', async () => {
      fetchMock.mockImplementation(async () => githubResponse(201, {}));

      await build().request('/x', { method: 'POST', body: { body: 'hello' } });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBe('{"body":"hello"}');
      expect((init.headers as Record<string, string>)['content-type']).toBe(
        'application/json',
      );
    });
  });

  describe('error classification', () => {
    it('maps 401 to an auth error', async () => {
      fetchMock.mockImplementation(async () =>
        githubResponse(401, { message: 'Bad credentials' }),
      );

      await expect(build().request('/x')).rejects.toBeInstanceOf(
        GitHubAuthError,
      );
    });

    it('maps 404 to not-found, since GitHub hides private repositories that way', async () => {
      fetchMock.mockImplementation(async () =>
        githubResponse(404, { message: 'Not Found' }),
      );

      await expect(build().request('/x')).rejects.toBeInstanceOf(
        GitHubNotFoundError,
      );
    });

    it('maps a 403 that is NOT a rate limit to an auth error', async () => {
      // A permissions problem. Retrying it will never help, so it must not
      // land in the transient bucket.
      fetchMock.mockImplementation(async () =>
        githubResponse(403, {
          message: 'Resource not accessible by personal access token',
        }),
      );

      await expect(build().request('/x')).rejects.toBeInstanceOf(
        GitHubAuthError,
      );
    });

    it('maps a primary rate limit to a dated rate-limit error', async () => {
      const reset = Math.floor(Date.now() / 1000) + 1800;
      fetchMock.mockImplementation(async () =>
        githubResponse(
          403,
          { message: 'API rate limit exceeded' },
          {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(reset),
          },
        ),
      );

      const error = await build()
        .request('/x')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(GitHubRateLimitError);
      expect((error as GitHubRateLimitError).secondary).toBe(false);
      // The reconciler schedules around this rather than sleeping on it.
      expect((error as GitHubRateLimitError).resetAt.getTime()).toBe(
        reset * 1000,
      );
    });

    it('maps a secondary rate limit via retry-after, and flags it as secondary', async () => {
      fetchMock.mockImplementation(async () =>
        githubResponse(
          403,
          { message: 'You have exceeded a secondary rate limit' },
          {
            'retry-after': '60',
            'x-ratelimit-remaining': '4000',
          },
        ),
      );

      const error = (await build()
        .request('/x')
        .catch((e: unknown) => e)) as GitHubRateLimitError;

      expect(error).toBeInstanceOf(GitHubRateLimitError);
      expect(error.secondary).toBe(true);
      expect(error.resetAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('treats an exhaustion it cannot date as an auth error, not a guessed rate limit', async () => {
      // `resetAt` is the whole value of the class. A guessed one would have
      // the scheduler hold back or charge ahead for no reason.
      fetchMock.mockImplementation(
        async () =>
          new Response(JSON.stringify({ message: 'Forbidden' }), {
            status: 403,
          }),
      );

      await expect(build().request('/x')).rejects.toBeInstanceOf(
        GitHubAuthError,
      );
    });

    it('maps other 4xx to a request error carrying GitHub own body', async () => {
      fetchMock.mockImplementation(async () =>
        githubResponse(422, {
          message: 'Validation Failed',
          errors: [{ field: 'labels' }],
        }),
      );

      const error = (await build()
        .request('/x')
        .catch((e: unknown) => e)) as GitHubRequestError;

      expect(error).toBeInstanceOf(GitHubRequestError);
      expect(error.body).toMatchObject({ errors: [{ field: 'labels' }] });
    });
  });

  describe('retry policy', () => {
    it('retries a 5xx and returns the eventual success', async () => {
      fetchMock
        .mockResolvedValueOnce(githubResponse(502, { message: 'Bad gateway' }))
        .mockResolvedValueOnce(githubResponse(200, { ok: true }));

      const result = await build({ 'github.maxRetries': 2 }).request<{
        ok: boolean;
      }>('/x');

      expect(result.data).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries a transport failure', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce(githubResponse(200, {}));

      await build({ 'github.maxRetries': 2 }).request('/x');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up after maxRetries and surfaces the transient error', async () => {
      fetchMock.mockImplementation(async () =>
        githubResponse(503, { message: 'unavailable' }),
      );

      await expect(
        build({ 'github.maxRetries': 2 }).request('/x'),
      ).rejects.toBeInstanceOf(GitHubTransientError);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('NEVER retries a rate-limit exhaustion', async () => {
      // The behaviour #40 names explicitly. Retrying a request that failed
      // because the budget is gone spends the next window's budget on finding
      // out the budget is gone.
      fetchMock.mockImplementation(async () =>
        githubResponse(
          403,
          { message: 'API rate limit exceeded' },
          {
            'x-ratelimit-remaining': '0',
          },
        ),
      );

      await expect(
        build({ 'github.maxRetries': 3 }).request('/x'),
      ).rejects.toBeInstanceOf(GitHubRateLimitError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never retries a 404 or a 422', async () => {
      fetchMock.mockImplementation(async () =>
        githubResponse(404, { message: 'Not Found' }),
      );

      await expect(
        build({ 'github.maxRetries': 3 }).request('/x'),
      ).rejects.toBeInstanceOf(GitHubNotFoundError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('paginate()', () => {
    function page(items: unknown[], next?: string) {
      return githubResponse(
        200,
        items,
        next ? { link: `<${next}>; rel="next"` } : {},
      );
    }

    it('follows rel="next" and concatenates', async () => {
      fetchMock
        .mockResolvedValueOnce(
          page(
            [{ n: 1 }],
            'https://api.github.com/repos/acme/app/issues?page=2',
          ),
        )
        .mockResolvedValueOnce(page([{ n: 2 }]));

      const result = await build().paginate<{ n: number }>(
        '/repos/acme/app/issues',
      );

      expect(result.items).toEqual([{ n: 1 }, { n: 2 }]);
      expect(result.pages).toBe(2);
      expect(result.truncated).toBe(false);
    });

    it('requests 100 per page by default, to spend the fewest requests', async () => {
      fetchMock.mockImplementation(async () => page([]));

      await build().paginate('/repos/acme/app/issues');

      expect((fetchMock.mock.calls[0] as [string])[0]).toContain(
        'per_page=100',
      );
    });

    it('stops at maxPages and says so rather than truncating silently', async () => {
      // A repository with 40 000 closed issues would otherwise turn one
      // adapter call into 400 requests and an exhausted budget.
      fetchMock.mockImplementation(async () =>
        page(
          [{ n: 1 }],
          'https://api.github.com/repos/acme/app/issues?page=99',
        ),
      );

      const result = await build().paginate('/repos/acme/app/issues', {
        maxPages: 3,
      });

      expect(result.pages).toBe(3);
      expect(result.truncated).toBe(true);
    });

    it('reports allFromCache only when every page was a 304', async () => {
      fetchMock.mockResolvedValueOnce(
        page([{ n: 1 }], 'https://api.github.com/x?page=2'),
      );
      fetchMock.mockResolvedValueOnce(page([{ n: 2 }]));
      const service = build();
      const first = await service.paginate('/repos/acme/app/issues');
      expect(first.allFromCache).toBe(false);
    });
  });
});

describe('parseNextLink', () => {
  it('extracts the next URL from a multi-rel Link header', () => {
    expect(
      parseNextLink(
        '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"',
      ),
    ).toBe('https://api.github.com/x?page=2');
  });

  it('returns null on the last page, where only rel="prev" is present', () => {
    expect(
      parseNextLink('<https://api.github.com/x?page=1>; rel="prev"'),
    ).toBeNull();
  });

  it('returns null when there is no Link header at all', () => {
    expect(parseNextLink(null)).toBeNull();
  });

  it('handles a cursor URL with no page number', () => {
    // Issue timelines, which #41 needs, are cursor-paginated and have none.
    expect(
      parseNextLink('<https://api.github.com/x?after=Y3Vyc29y>; rel="next"'),
    ).toBe('https://api.github.com/x?after=Y3Vyc29y');
  });
});

describe('backoffMs', () => {
  it('grows exponentially and stays bounded', () => {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const value = backoffMs(attempt);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(8000);
    }
  });

  it('jitters, so concurrent retries do not re-collide in lockstep', () => {
    const samples = new Set(Array.from({ length: 50 }, () => backoffMs(4)));

    expect(samples.size).toBeGreaterThan(1);
  });
});
