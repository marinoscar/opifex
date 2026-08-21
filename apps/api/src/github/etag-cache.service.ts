import { Injectable, Logger } from '@nestjs/common';

export interface CachedResponse {
  etag: string;
  /** The parsed body of the last full response for this key. */
  body: unknown;
  /** `Link` header of that response, so a 304 can replay pagination. */
  link: string | null;
  storedAt: Date;
}

/**
 * The conditional-request store: what GitHub last sent for a URL, and the
 * ETag that proves whether it still holds.
 *
 * ## Why this is not optional
 *
 * VISION §13 says start with polling and add webhooks only when tick latency
 * demonstrably hurts. Polling without conditional requests exhausts the API
 * budget: a tick that reads issues, labels, PRs and checks for every watched
 * repository, every few minutes, spends thousands of requests an hour to
 * discover that nothing changed. A 304 does not count against the primary
 * rate limit, so an unchanged repository costs GitHub bandwidth and Opifex
 * nothing.
 *
 * ## Why bodies are stored, not just ETags
 *
 * A 304 has no body. A cache that held only ETags could tell the caller
 * "unchanged" but not what it was unchanged FROM, so every consumer would
 * need its own copy — and the first one to forget would silently turn a 304
 * into a missing result. Storing the body here makes "unchanged" a complete
 * answer.
 *
 * ## Why in memory, and what that costs
 *
 * A cold start re-fetches everything once, spending a few hundred requests
 * out of 5000/hour, and is then warm. That is a real cost and it is the right
 * trade: persisting the bodies would mean a schema for arbitrary GitHub
 * payloads, a staleness policy of its own, and a second thing to invalidate
 * when a token's visibility changes. The LRU bound below is what stops a
 * process that watches many repositories from growing without limit.
 */
@Injectable()
export class EtagCacheService {
  private readonly logger = new Logger(EtagCacheService.name);

  /**
   * Insertion-ordered, which is what makes the LRU a one-liner: `Map`
   * iteration yields oldest-first, and re-inserting on read moves an entry to
   * the end.
   */
  private readonly entries = new Map<string, CachedResponse>();

  constructor(private readonly maxEntries: number) {}

  /**
   * The cache key. Includes the method because a `HEAD` and a `GET` on one URL
   * are different responses, and GitHub's ETags are not interchangeable
   * between them.
   */
  static key(method: string, url: string): string {
    return `${method.toUpperCase()} ${url}`;
  }

  get(method: string, url: string): CachedResponse | undefined {
    const key = EtagCacheService.key(method, url);
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    // Touch: move to the end so the LRU evicts genuinely cold entries rather
    // than merely old ones. A repository polled every tick must never be
    // evicted by a one-off read of a repository nobody looks at again.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(method: string, url: string, entry: CachedResponse): void {
    const key = EtagCacheService.key(method, url);
    this.entries.delete(key);
    this.entries.set(key, entry);

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /**
   * Drop everything for one repository.
   *
   * Needed when a repository is de-registered or its token's visibility
   * changes: a cached 200 from a token that could see a private repository
   * must not be replayed to one that cannot.
   */
  invalidateRepository(owner: string, name: string): number {
    const marker = `/repos/${owner}/${name}`;
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (key.includes(marker)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.logger.debug(`Invalidated ${removed} cached responses for ${owner}/${name}`);
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
