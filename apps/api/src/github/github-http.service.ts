import { Injectable, Logger } from '@nestjs/common';

import { OperatorSettingsService } from '../settings/operator-settings/operator-settings.service';
import { EtagCacheService } from './etag-cache.service';
import {
  GitHubAuthError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubRequestError,
  GitHubTransientError,
} from './github.errors';
import { RateLimitService, RateLimitResource } from './rate-limit.service';

export interface GitHubRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Query parameters. Undefined values are dropped rather than sent empty. */
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Which budget this spends. Only `search` differs in practice. */
  resource?: RateLimitResource;
  /**
   * Send `If-None-Match` when a cached ETag exists. Default true for GET,
   * always false otherwise — a conditional write is a different feature with
   * different semantics, and GitHub does not offer it on these endpoints.
   */
  conditional?: boolean;
  /** Accept header override, for previews and the raw-body media types. */
  accept?: string;
}

/**
 * The per-request policy one call resolved for itself, carried through that
 * call's retries so every attempt within it agrees (#341).
 */
interface RequestPolicy {
  token: string | undefined;
  timeoutMs: number;
}

export interface GitHubResponse<T> {
  data: T;
  status: number;
  /** True when GitHub answered 304 and `data` came from the cache. */
  fromCache: boolean;
  /** The `Link` header, for pagination. */
  link: string | null;
  etag: string | null;
}

/**
 * The single HTTP pipeline to GitHub: authentication, rate-limit accounting,
 * conditional requests, retry, and pagination.
 *
 * ## No SDK
 *
 * This uses the platform `fetch` rather than Octokit. The three things #40
 * asks for — rate-limit remaining as queryable state, conditional requests
 * with 304 accounting, and "surface exhaustion rather than retry into it" —
 * are precisely the behaviours an SDK's defaults abstract away or actively
 * fight: Octokit's throttling plugin sleeps on a rate-limit reset, which is
 * the one response a reconciler must not have (it blocks the tick that is
 * supposed to be observing everything else). The choice is recorded in
 * docs/adr/0002-github-http-client.md.
 *
 * ## Read and write share this, and that is not a hole
 *
 * Both adapter layers issue requests through this service, but the read/write
 * boundary is enforced one level up: `GitHubReadModule` exports only read
 * adapters and there is no write adapter for anything on VISION §8's
 * never-trustable list. This layer is the transport; the boundary is what is
 * built on top of it.
 */
@Injectable()
export class GitHubHttpService {
  private readonly logger = new Logger(GitHubHttpService.name);

  /**
   * The host, and the identity sent to it. FROZEN AT CONSTRUCTION, deliberately
   * — do not "improve" these into live reads.
   *
   * `EtagCacheService` is keyed by request PATH, not by host
   * (`etag-cache.service.ts`). Swapping `github.apiBaseUrl` inside a running
   * process would therefore replay one host's ETags against another and take
   * the resulting 304s as confirmation of bodies that host has never sent — a
   * cache handing back a different server's answers, which is silently wrong
   * rather than merely stale. The registry says `restart` on that key for this
   * exact reason. `userAgent` is frozen with it because it is part of the same
   * "which deployment is this, talking to which host" identity: it is only ever
   * meaningful alongside the base URL it is presented to, and letting the two
   * halves of one identity change on different schedules buys nothing.
   */
  private readonly baseUrl: string;
  private readonly userAgent: string;

  constructor(
    private readonly settings: OperatorSettingsService,
    private readonly rateLimit: RateLimitService,
    private readonly etags: EtagCacheService,
  ) {
    this.baseUrl = this.settings.get('github.apiBaseUrl').replace(/\/$/, '');
    this.userAgent = this.settings.get('github.userAgent');

    if (!this.token) {
      // Not a throw: the API must boot without GitHub configured so the
      // inherited foundation stays usable, and #43's registration check is
      // where a missing token becomes a visible, actionable error rather than
      // a container that will not start.
      this.logger.warn(
        'GITHUB_TOKEN is not set - every GitHub request will fail with an auth error',
      );
    }
  }

  /**
   * Per-request policy, resolved on every use rather than captured (#341).
   *
   * None of these has a cross-request invariant: a change lands on the next
   * request and nothing downstream can observe an inconsistency. Within ONE
   * request they are resolved exactly once, at the top of `request()`, so a
   * rotation cannot land between the "is a token configured" check and the
   * `Authorization` header built from it, and cannot change the retry budget
   * a loop is already counting against.
   *
   * The token in particular is why this issue exists: `RunWorkspaceService`
   * already reads `github.token` live for git operations, so a frozen copy
   * here meant one rotation applying to `git push` and not to the API call
   * beside it.
   */
  private get token(): string | undefined {
    // The registry's default is the empty string, so `|| undefined` keeps the
    // exact "unset means unconfigured" reading this had against `ConfigService`.
    return this.settings.get('github.token') || undefined;
  }

  private get timeoutMs(): number {
    return this.settings.get('github.requestTimeoutMs');
  }

  private get maxRetries(): number {
    return this.settings.get('github.maxRetries');
  }

  private get rateLimitReserve(): number {
    return this.settings.get('github.rateLimitReserve');
  }

  /** Whether a credential is configured at all, as of right now. */
  get configured(): boolean {
    return this.token !== undefined;
  }

  /**
   * One request, with everything applied.
   *
   * Throws rather than returning an error union, because the interesting cases
   * (`GitHubRateLimitError`, `GitHubNotFoundError`) are handled several frames
   * up by a reconciler that decides scheduling, not by the adapter that made
   * the call.
   */
  async request<T>(
    path: string,
    options: GitHubRequestOptions = {},
  ): Promise<GitHubResponse<T>> {
    const method = options.method ?? 'GET';
    const url = this.buildUrl(path, options.query);
    const conditional = options.conditional ?? method === 'GET';

    // Resolved ONCE, here, and then carried through the retry loop. Reading
    // them again per attempt would let a rotation mid-retry send the check's
    // token on one attempt and a different one on the next, and would let a
    // loop already counting attempts against a budget of 3 find itself
    // counting against a budget of 0.
    const policy: RequestPolicy = {
      token: this.token,
      timeoutMs: this.timeoutMs,
    };
    const maxRetries = this.maxRetries;

    if (!policy.token) {
      throw new GitHubAuthError(
        'No GitHub credential configured (set GITHUB_TOKEN)',
        null,
        method,
        path,
      );
    }

    const cached = conditional ? this.etags.get(method, url) : undefined;

    let lastTransient: GitHubTransientError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        await delay(backoffMs(attempt));
      }

      try {
        return await this.attempt<T>(
          method,
          url,
          path,
          options,
          cached,
          policy,
        );
      } catch (error) {
        if (error instanceof GitHubTransientError) {
          lastTransient = error;
          this.logger.warn(
            `${method} ${path} failed transiently (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}`,
          );
          continue;
        }
        // Rate-limit exhaustion, auth, 404 and other 4xx are all final.
        // Retrying an exhausted budget spends the next window on finding out
        // the budget is gone - #40 is explicit that exhaustion is surfaced,
        // not retried into.
        throw error;
      }
    }

    throw (
      lastTransient ??
      new GitHubTransientError('Request failed', null, method, path)
    );
  }

  /**
   * Follow `Link: rel="next"` to the end and concatenate the pages.
   *
   * Pagination is handled here so no adapter has to think about it (#41), and
   * `maxPages` is a real bound rather than a formality: a repository with
   * 40 000 closed issues would otherwise turn one adapter call into 400
   * requests and an exhausted budget.
   */
  async paginate<T>(
    path: string,
    options: GitHubRequestOptions & {
      perPage?: number;
      maxPages?: number;
      /**
       * Pull the array out of a page body that is not itself an array.
       *
       * Several GitHub endpoints wrap their results in an envelope — check
       * runs return `{ total_count, check_runs: [...] }`, search returns
       * `{ items: [...] }` — while paginating with the same `Link` header as
       * the plain list endpoints. Without this the concatenation silently
       * collects nothing and the caller sees an empty result rather than an
       * error, which reads as "CI has nothing to say" exactly where a false
       * green is most expensive (#107).
       */
      extract?: (page: unknown) => T[];
    } = {},
  ): Promise<{
    items: T[];
    pages: number;
    truncated: boolean;
    allFromCache: boolean;
  }> {
    const perPage = options.perPage ?? 100;
    const maxPages = options.maxPages ?? 10;
    const extract =
      options.extract ??
      ((page: unknown) => (Array.isArray(page) ? (page as T[]) : []));

    const items: T[] = [];
    let next: string | null = this.buildUrl(path, {
      ...options.query,
      per_page: perPage,
    });
    let pages = 0;
    let allFromCache = true;

    while (next && pages < maxPages) {
      const response: GitHubResponse<unknown> =
        await this.requestAbsolute<unknown>(next, options);
      pages += 1;
      allFromCache = allFromCache && response.fromCache;

      items.push(...extract(response.data));
      next = parseNextLink(response.link);
    }

    return { items, pages, truncated: next !== null, allFromCache };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async requestAbsolute<T>(
    url: string,
    options: GitHubRequestOptions,
  ): Promise<GitHubResponse<T>> {
    // `paginate` already resolved the absolute URL (GitHub's Link header gives
    // absolute next-page URLs), so strip the base back off rather than
    // re-encoding the query it built.
    const path = url.startsWith(this.baseUrl)
      ? url.slice(this.baseUrl.length)
      : url;
    return this.request<T>(path, { ...options, query: undefined });
  }

  private async attempt<T>(
    method: string,
    url: string,
    path: string,
    options: GitHubRequestOptions,
    cached: { etag: string; body: unknown; link: string | null } | undefined,
    policy: RequestPolicy,
  ): Promise<GitHubResponse<T>> {
    const headers: Record<string, string> = {
      accept: options.accept ?? 'application/vnd.github+json',
      authorization: `Bearer ${policy.token}`,
      'user-agent': this.userAgent,
      'x-github-api-version': '2022-11-28',
    };
    if (cached) {
      headers['if-none-match'] = cached.etag;
    }
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(policy.timeoutMs),
      });
    } catch (error) {
      // A timeout or socket failure. No headers, so no rate-limit news.
      throw new GitHubTransientError(
        withoutToken(
          error instanceof Error ? error.message : 'Network failure',
          policy.token,
        ),
        null,
        method,
        path,
        error,
      );
    }

    // Record the budget from EVERY response, including errors: a 403 saying
    // `remaining: 0` is the most informative response the client ever gets.
    this.rateLimit.record(response.headers);

    if (response.status === 304 && cached) {
      this.rateLimit.recordConditionalHit();
      return {
        data: cached.body as T,
        status: 304,
        fromCache: true,
        link: cached.link,
        etag: cached.etag,
      };
    }

    if (response.ok) {
      if (cached) {
        this.rateLimit.recordConditionalMiss();
      }
      const etag = response.headers.get('etag');
      const link = response.headers.get('link');
      const data = (await parseBody(response)) as T;

      if (etag && (options.conditional ?? method === 'GET')) {
        this.etags.set(method, url, {
          etag,
          body: data,
          link,
          storedAt: new Date(),
        });
      }

      return { data, status: response.status, fromCache: false, link, etag };
    }

    throw await this.toError(response, method, path, policy.token);
  }

  private async toError(
    response: Response,
    method: string,
    path: string,
    token: string | undefined,
  ) {
    const body = await parseBody(response).catch(() => undefined);
    // Redacted HERE, at the one place that holds the credential, rather than
    // by each consumer. ADR-0001: the token is consumed in exactly one place,
    // so this is the only layer that CAN take it back out — and these messages
    // are logged and rendered several frames up. GitHub itself never echoes a
    // bearer token, but `github.apiBaseUrl` is an operator-settable override
    // and a proxy sitting on it is under nobody's control.
    const message = withoutToken(
      extractMessage(body) ?? response.statusText,
      token,
    );

    if (response.status === 401) {
      return new GitHubAuthError(
        `GitHub rejected the credential: ${message}`,
        401,
        method,
        path,
      );
    }

    if (response.status === 403 || response.status === 429) {
      const rateLimitError = this.asRateLimitError(
        response,
        method,
        path,
        message,
      );
      if (rateLimitError) return rateLimitError;

      // A 403 that is not a rate limit is a permissions problem: the token
      // cannot do this. Retrying will never help.
      return new GitHubAuthError(
        `GitHub refused the request: ${message}`,
        response.status,
        method,
        path,
      );
    }

    if (response.status === 404) {
      // GitHub returns 404 rather than 403 for a private repository the token
      // cannot see, so "missing" and "invisible" are genuinely the same answer.
      //
      // GitHub's own message is kept in the text because 404 is overloaded on
      // some endpoints and the message is the only thing separating the cases:
      // removing a label that is not on an issue answers 404 "Label does not
      // exist", while a wrong issue number answers 404 "Not Found". A caller
      // that had only the status would have to treat both as benign.
      return new GitHubNotFoundError(
        `${message} (${method} ${path})`,
        404,
        method,
        path,
      );
    }

    if (response.status >= 500) {
      return new GitHubTransientError(
        `GitHub server error ${response.status}: ${message}`,
        response.status,
        method,
        path,
      );
    }

    return new GitHubRequestError(
      `GitHub rejected ${method} ${path}: ${message}`,
      response.status,
      method,
      path,
      body,
    );
  }

  /**
   * Distinguish the two rate limits from everything else a 403 can mean.
   *
   * Primary exhaustion: `x-ratelimit-remaining: 0`, reset in
   * `x-ratelimit-reset`. Secondary (abuse detection): a `retry-after` in
   * seconds and no exhausted primary budget. They are reported as one error
   * class with a `secondary` flag because the caller's response is the same
   * shape — schedule around `resetAt` — while the diagnosis differs.
   */
  private asRateLimitError(
    response: Response,
    method: string,
    path: string,
    message: string,
  ): GitHubRateLimitError | null {
    const retryAfter = Number.parseInt(
      response.headers.get('retry-after') ?? '',
      10,
    );
    if (!Number.isNaN(retryAfter)) {
      return new GitHubRateLimitError(
        `Secondary rate limit on ${method} ${path}: ${message}`,
        response.status,
        method,
        path,
        new Date(Date.now() + retryAfter * 1000),
        true,
      );
    }

    const remaining = Number.parseInt(
      response.headers.get('x-ratelimit-remaining') ?? '',
      10,
    );
    const reset = Number.parseInt(
      response.headers.get('x-ratelimit-reset') ?? '',
      10,
    );
    if (remaining === 0 && !Number.isNaN(reset)) {
      return new GitHubRateLimitError(
        `Rate limit exhausted on ${method} ${path}: ${message}`,
        response.status,
        method,
        path,
        new Date(reset * 1000),
        false,
      );
    }

    // Exhausted but undateable is deliberately NOT a rate-limit error:
    // `resetAt` is the whole value of the class, and a guessed one would have
    // the scheduler hold back or charge ahead for no reason.
    return null;
  }

  /** Whether there is budget left, keeping the configured reserve in hand. */
  canSpend(resource: RateLimitResource = 'core'): boolean {
    return this.rateLimit.canSpend(this.rateLimitReserve, resource);
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(
      path.startsWith('http') ? path : `${this.baseUrl}${path}`,
    );
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

/**
 * A message with the credential that was sent taken out of it.
 *
 * Whole-token only, and never a heuristic: anything clever enough to redact
 * "something token-shaped" would also mangle the commit SHAs and request ids
 * that make a GitHub failure diagnosable. What this guarantees is the one
 * thing worth guaranteeing — the exact secret we sent never comes back out of
 * an error message, into a log line or onto a screen.
 */
export function withoutToken(
  message: string,
  token: string | undefined,
): string {
  // Short enough to be a placeholder rather than a credential, and splitting
  // on it would shred an unrelated message.
  if (token === undefined || token.length < 8) return message;
  return message.split(token).join('[redacted]');
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractMessage(body: unknown): string | null {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return null;
}

/**
 * `Link: <https://api.github.com/…&page=2>; rel="next", <…>; rel="last"`.
 *
 * Parsed rather than page-counted because GitHub's cursor-paginated endpoints
 * (issue timelines among them, which #41 needs) have no page numbers at all.
 */
export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/** Exponential with full jitter: 1s, 2s, 4s, each randomised downward. */
export function backoffMs(attempt: number): number {
  const ceiling = Math.min(1000 * 2 ** (attempt - 1), 8000);
  return Math.floor(Math.random() * ceiling);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
