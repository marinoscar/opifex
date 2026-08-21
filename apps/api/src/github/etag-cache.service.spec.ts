import { EtagCacheService } from './etag-cache.service';

function entry(etag: string, body: unknown = { ok: true }) {
  return { etag, body, link: null, storedAt: new Date() };
}

describe('EtagCacheService', () => {
  describe('keying', () => {
    it('separates methods on one URL', () => {
      // GitHub's ETags are not interchangeable between a HEAD and a GET, so a
      // key that ignored the method would replay the wrong body.
      const cache = new EtagCacheService(10);
      cache.set('GET', 'https://api.github.com/repos/a/b', entry('"get"'));
      cache.set('HEAD', 'https://api.github.com/repos/a/b', entry('"head"'));

      expect(cache.get('GET', 'https://api.github.com/repos/a/b')!.etag).toBe('"get"');
      expect(cache.get('HEAD', 'https://api.github.com/repos/a/b')!.etag).toBe('"head"');
    });

    it('normalises the method case', () => {
      const cache = new EtagCacheService(10);
      cache.set('get', 'https://api.github.com/x', entry('"e"'));

      expect(cache.get('GET', 'https://api.github.com/x')).toBeDefined();
    });

    it('misses on an unknown URL', () => {
      expect(new EtagCacheService(10).get('GET', 'https://api.github.com/x')).toBeUndefined();
    });
  });

  describe('bounding', () => {
    it('never exceeds its maximum', () => {
      const cache = new EtagCacheService(3);
      for (let i = 0; i < 10; i += 1) {
        cache.set('GET', `https://api.github.com/${i}`, entry(`"${i}"`));
      }

      expect(cache.size).toBe(3);
    });

    it('evicts the least recently USED, not the oldest stored', () => {
      // The case that matters: a repository polled every tick must not be
      // evicted by a one-off read of a repository nobody looks at again.
      const cache = new EtagCacheService(2);
      cache.set('GET', 'https://api.github.com/hot', entry('"hot"'));
      cache.set('GET', 'https://api.github.com/cold', entry('"cold"'));

      cache.get('GET', 'https://api.github.com/hot');
      cache.set('GET', 'https://api.github.com/new', entry('"new"'));

      expect(cache.get('GET', 'https://api.github.com/hot')).toBeDefined();
      expect(cache.get('GET', 'https://api.github.com/cold')).toBeUndefined();
    });

    it('re-setting an existing key does not grow the cache', () => {
      const cache = new EtagCacheService(2);
      cache.set('GET', 'https://api.github.com/x', entry('"1"'));
      cache.set('GET', 'https://api.github.com/x', entry('"2"'));

      expect(cache.size).toBe(1);
      expect(cache.get('GET', 'https://api.github.com/x')!.etag).toBe('"2"');
    });
  });

  describe('invalidateRepository()', () => {
    it('drops every cached response for that repository', () => {
      // Needed when a token's visibility changes: a cached 200 from a token
      // that could see a private repository must not be replayed to one that
      // cannot.
      const cache = new EtagCacheService(10);
      cache.set('GET', 'https://api.github.com/repos/acme/app/issues', entry('"i"'));
      cache.set('GET', 'https://api.github.com/repos/acme/app/labels', entry('"l"'));
      cache.set('GET', 'https://api.github.com/repos/acme/other/issues', entry('"o"'));

      expect(cache.invalidateRepository('acme', 'app')).toBe(2);
      expect(cache.get('GET', 'https://api.github.com/repos/acme/other/issues')).toBeDefined();
    });

    it('reports zero when nothing matched', () => {
      expect(new EtagCacheService(10).invalidateRepository('acme', 'app')).toBe(0);
    });
  });

  it('clear() empties it', () => {
    const cache = new EtagCacheService(10);
    cache.set('GET', 'https://api.github.com/x', entry('"e"'));
    cache.clear();

    expect(cache.size).toBe(0);
  });
});
