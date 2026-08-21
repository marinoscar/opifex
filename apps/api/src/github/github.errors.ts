/**
 * The failure vocabulary of the GitHub edge.
 *
 * These exist as distinct classes rather than one error with a `code`, because
 * the caller's response genuinely differs per case and the difference is the
 * whole point of #40:
 *
 *  - `GitHubRateLimitError` must NOT be retried into. Retrying a request that
 *    failed because the budget is gone spends the next window's budget on
 *    finding out the budget is gone.
 *  - `GitHubTransientError` is exactly what backoff is for.
 *  - `GitHubNotFoundError` is often a normal answer (an issue was deleted),
 *    not a failure at all.
 *
 * Collapsing them means the retry policy has to re-derive the distinction
 * from a status code at every call site, and one call site will get it wrong.
 */

/** Base class, so a caller can catch everything from this module at once. */
export class GitHubError extends Error {
  constructor(
    message: string,
    /** The HTTP status, or null for a transport-level failure. */
    readonly status: number | null,
    readonly method: string,
    readonly path: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The primary rate limit is exhausted, or a secondary limit is in force.
 *
 * Carries `resetAt` because the reconciler's correct response is to schedule
 * around it, not to sleep on it — a control plane that blocks a tick thread on
 * a rate-limit reset has stopped observing everything else too.
 */
export class GitHubRateLimitError extends GitHubError {
  constructor(
    message: string,
    status: number,
    method: string,
    path: string,
    /** When the budget returns. Never null: an exhaustion we cannot date is
     *  reported as a transient failure instead, because scheduling around an
     *  unknown reset is indistinguishable from guessing. */
    readonly resetAt: Date,
    /** True for a secondary (abuse-detection) limit, which has different
     *  semantics: it is per-endpoint and short, and `retry-after` dates it. */
    readonly secondary: boolean,
  ) {
    super(message, status, method, path);
  }
}

/**
 * A failure that a later identical request might survive: 5xx, a timeout, a
 * socket error. The only category the client retries.
 */
export class GitHubTransientError extends GitHubError {
  constructor(
    message: string,
    status: number | null,
    method: string,
    path: string,
    readonly cause?: unknown,
  ) {
    super(message, status, method, path);
  }
}

/** The credential is missing, wrong, or lacks the scope for this call. */
export class GitHubAuthError extends GitHubError {}

/** The resource does not exist, or the token cannot see it — GitHub does not
 *  distinguish the two for private repositories, and neither can we. */
export class GitHubNotFoundError extends GitHubError {}

/** Anything else GitHub rejected: 4xx that is none of the above. */
export class GitHubRequestError extends GitHubError {
  constructor(
    message: string,
    status: number,
    method: string,
    path: string,
    /** GitHub's own error body, when it sent a parseable one. */
    readonly body?: unknown,
  ) {
    super(message, status, method, path);
  }
}
