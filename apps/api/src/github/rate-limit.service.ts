import { Injectable, Logger } from '@nestjs/common';

/**
 * The GitHub rate-limit resources Opifex touches. GitHub budgets these
 * separately, so a single "remaining" number would be wrong the moment a
 * search runs: `search` is 30/minute where `core` is 5000/hour.
 */
export type RateLimitResource = 'core' | 'search' | 'graphql' | 'integration_manifest';

export interface RateLimitSnapshot {
  resource: RateLimitResource;
  /** The window's total budget. */
  limit: number;
  /** How much of it is left. */
  remaining: number;
  /** When the window resets and `remaining` returns to `limit`. */
  resetAt: Date;
  /** When this snapshot was taken from a response header. */
  observedAt: Date;
}

/**
 * What the reconciler knows about its remaining GitHub budget.
 *
 * ## Why this is a service and not a number on the client
 *
 * VISION §11 notes that automated runs compete with interactive use for the
 * same limits, which makes remaining budget a SCHEDULING INPUT rather than an
 * error-handling detail. #40 states the requirement directly: rate-limit
 * remaining must be queryable state, not something discovered by receiving a
 * 403. A tick that can ask "do I have the budget for this sweep" before
 * starting it behaves completely differently from one that finds out halfway
 * through.
 *
 * ## Why it is in memory
 *
 * The numbers are only true for the process holding the token, and GitHub
 * re-states them on every single response — so persistence would add a write
 * per request to store a value that is refreshed a moment later, and would go
 * stale the instant another process spent from the same budget. The
 * authoritative copy is always GitHub's next response header. This is a cache
 * of the last one, and a cold start is correctly reported as "unknown"
 * (`snapshot()` returns null) rather than as a full budget.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly snapshots = new Map<RateLimitResource, RateLimitSnapshot>();

  /**
   * How many conditional requests came back 304, and therefore cost nothing.
   *
   * Tracked because #40's ETag requirement is only worth anything if it can be
   * shown to be working: a client that sends `If-None-Match` but gets 200
   * every time is burning its budget exactly as fast as one that does not,
   * and nothing else in the system would notice.
   */
  private conditionalHits = 0;
  private conditionalMisses = 0;

  /**
   * Record what a response said about the budget.
   *
   * Every response carries these headers, including a 304 and including an
   * error — so this is called on all of them, not just successes. A 403 that
   * says `remaining: 0` is the single most informative response the client
   * ever gets, and dropping it because the request failed would be the exact
   * mistake this service exists to prevent.
   */
  record(headers: Headers): RateLimitSnapshot | null {
    const limit = toInt(headers.get('x-ratelimit-limit'));
    const remaining = toInt(headers.get('x-ratelimit-remaining'));
    const reset = toInt(headers.get('x-ratelimit-reset'));

    if (limit === null || remaining === null || reset === null) {
      // Not every GitHub response carries them (some error paths do not).
      // Leaving the previous snapshot in place is right: a missing header is
      // no news, not news of a full budget.
      return null;
    }

    const resource = normalizeResource(headers.get('x-ratelimit-resource'));
    const snapshot: RateLimitSnapshot = {
      resource,
      limit,
      remaining,
      resetAt: new Date(reset * 1000),
      observedAt: new Date(),
    };

    this.snapshots.set(resource, snapshot);
    return snapshot;
  }

  /** Count a conditional request that GitHub answered 304. */
  recordConditionalHit(): void {
    this.conditionalHits += 1;
  }

  /** Count a conditional request GitHub answered with a full body. */
  recordConditionalMiss(): void {
    this.conditionalMisses += 1;
  }

  /**
   * The last thing GitHub said about a resource, or null if it has never said
   * anything in this process's lifetime.
   *
   * Null is a real answer and callers must handle it. Reporting an unknown
   * budget as a full one is how a control plane walks into an exhaustion it
   * was built to schedule around.
   */
  snapshot(resource: RateLimitResource = 'core'): RateLimitSnapshot | null {
    const snapshot = this.snapshots.get(resource);
    if (!snapshot) return null;

    // Past its reset, the recorded `remaining` is stale in the one direction
    // that matters — the budget has refilled — so report the refill rather
    // than a number that would make the scheduler hold back for nothing.
    if (snapshot.resetAt.getTime() <= Date.now()) {
      return { ...snapshot, remaining: snapshot.limit };
    }
    return snapshot;
  }

  /**
   * Whether there is budget to spend, keeping `reserve` requests in hand.
   *
   * The reserve exists because the budget is shared with interactive use
   * (VISION §11): a reconciler that spends to the last request leaves the
   * operator unable to look at their own repository from a browser. An
   * unknown budget answers `true` — a cold start must be able to make its
   * first request, and that request is what populates the state.
   */
  canSpend(reserve: number, resource: RateLimitResource = 'core'): boolean {
    const snapshot = this.snapshot(resource);
    if (!snapshot) return true;
    return snapshot.remaining > reserve;
  }

  /** Everything known, for the health endpoint and the cost screen. */
  report(): {
    resources: RateLimitSnapshot[];
    conditionalHits: number;
    conditionalMisses: number;
  } {
    return {
      resources: [...this.snapshots.keys()]
        .map((resource) => this.snapshot(resource))
        .filter((s): s is RateLimitSnapshot => s !== null),
      conditionalHits: this.conditionalHits,
      conditionalMisses: this.conditionalMisses,
    };
  }

  /** Test seam, and the reset a token rotation needs. */
  clear(): void {
    this.snapshots.clear();
    this.conditionalHits = 0;
    this.conditionalMisses = 0;
    this.logger.debug('Rate-limit state cleared');
  }
}

function toInt(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

const KNOWN_RESOURCES: readonly RateLimitResource[] = [
  'core',
  'search',
  'graphql',
  'integration_manifest',
];

/**
 * GitHub sends `x-ratelimit-resource` on most responses but not all, and may
 * add resources we do not know about. An unrecognised value is folded into
 * `core` rather than creating a bucket nothing will ever query.
 */
function normalizeResource(value: string | null): RateLimitResource {
  if (value && (KNOWN_RESOURCES as readonly string[]).includes(value)) {
    return value as RateLimitResource;
  }
  return 'core';
}
