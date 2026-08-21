import { RateLimitService } from './rate-limit.service';

/** GitHub's rate-limit headers, as a `Headers` the service can read. */
function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

function resetIn(seconds: number): string {
  return String(Math.floor(Date.now() / 1000) + seconds);
}

describe('RateLimitService', () => {
  let service: RateLimitService;

  beforeEach(() => {
    service = new RateLimitService();
  });

  describe('cold start', () => {
    it('reports an unknown budget as unknown, not as a full one', () => {
      // The distinction #40 exists for: a control plane that treats "I have
      // not asked yet" as "5000 remaining" walks into the exhaustion it was
      // built to schedule around.
      expect(service.snapshot()).toBeNull();
    });

    it('still allows the first request, which is what populates the state', () => {
      expect(service.canSpend(100)).toBe(true);
    });
  });

  describe('record()', () => {
    it('captures limit, remaining and reset from the headers', () => {
      const reset = resetIn(3600);
      service.record(
        headers({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4987',
          'x-ratelimit-reset': reset,
          'x-ratelimit-resource': 'core',
        }),
      );

      const snapshot = service.snapshot();
      expect(snapshot).toMatchObject({ resource: 'core', limit: 5000, remaining: 4987 });
      expect(snapshot!.resetAt.getTime()).toBe(Number(reset) * 1000);
    });

    it('keeps search and core budgets apart', () => {
      // 30/minute versus 5000/hour. One "remaining" number would be wrong for
      // whichever resource was not the last one queried.
      service.record(
        headers({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4000',
          'x-ratelimit-reset': resetIn(3600),
          'x-ratelimit-resource': 'core',
        }),
      );
      service.record(
        headers({
          'x-ratelimit-limit': '30',
          'x-ratelimit-remaining': '2',
          'x-ratelimit-reset': resetIn(60),
          'x-ratelimit-resource': 'search',
        }),
      );

      expect(service.snapshot('core')!.remaining).toBe(4000);
      expect(service.snapshot('search')!.remaining).toBe(2);
    });

    it('folds an unrecognised resource into core rather than creating a bucket nobody queries', () => {
      service.record(
        headers({
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': '99',
          'x-ratelimit-reset': resetIn(60),
          'x-ratelimit-resource': 'some_future_resource',
        }),
      );

      expect(service.snapshot('core')!.limit).toBe(100);
    });

    it('leaves the previous snapshot alone when a response carries no headers', () => {
      service.record(
        headers({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4000',
          'x-ratelimit-reset': resetIn(3600),
        }),
      );

      expect(service.record(headers({}))).toBeNull();
      // A missing header is no news, not news of a full budget.
      expect(service.snapshot()!.remaining).toBe(4000);
    });

    it('ignores a header that is not a number', () => {
      expect(
        service.record(
          headers({
            'x-ratelimit-limit': 'unlimited',
            'x-ratelimit-remaining': '4000',
            'x-ratelimit-reset': resetIn(60),
          }),
        ),
      ).toBeNull();
    });
  });

  describe('window expiry', () => {
    it('reports the refill once the window has reset', () => {
      service.record(
        headers({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '3',
          // Already in the past.
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) - 5),
        }),
      );

      // Holding back on a stale "3 remaining" would idle the reconciler for a
      // window that has already refilled.
      expect(service.snapshot()!.remaining).toBe(5000);
      expect(service.canSpend(100)).toBe(true);
    });
  });

  describe('canSpend()', () => {
    beforeEach(() => {
      service.record(
        headers({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '100',
          'x-ratelimit-reset': resetIn(3600),
        }),
      );
    });

    it('stops with the reserve still in hand', () => {
      // VISION §11: the automated budget IS the operator's budget. Spending to
      // the last request locks the human out of their own repository.
      expect(service.canSpend(100)).toBe(false);
      expect(service.canSpend(99)).toBe(true);
    });
  });

  describe('conditional-request accounting', () => {
    it('counts hits and misses separately', () => {
      // A client that sends If-None-Match but always gets 200 burns budget at
      // exactly the rate of one that never sends it, and nothing else in the
      // system would notice.
      service.recordConditionalHit();
      service.recordConditionalHit();
      service.recordConditionalMiss();

      expect(service.report()).toMatchObject({ conditionalHits: 2, conditionalMisses: 1 });
    });
  });

  describe('report()', () => {
    it('lists every resource seen', () => {
      service.record(
        headers({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4000',
          'x-ratelimit-reset': resetIn(3600),
          'x-ratelimit-resource': 'core',
        }),
      );
      service.record(
        headers({
          'x-ratelimit-limit': '30',
          'x-ratelimit-remaining': '30',
          'x-ratelimit-reset': resetIn(60),
          'x-ratelimit-resource': 'search',
        }),
      );

      expect(
        service
          .report()
          .resources.map((r) => r.resource)
          .sort(),
      ).toEqual(['core', 'search']);
    });
  });

  describe('clear()', () => {
    it('returns the service to a cold start', () => {
      service.record(
        headers({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4000',
          'x-ratelimit-reset': resetIn(3600),
        }),
      );
      service.recordConditionalHit();

      service.clear();

      expect(service.snapshot()).toBeNull();
      expect(service.report().conditionalHits).toBe(0);
    });
  });
});
