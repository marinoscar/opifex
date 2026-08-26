import {
  DEFAULT_PROBE_RATE_LIMIT,
  ProbeRateLimiter,
} from './probe-rate-limiter';

/**
 * The window arithmetic, on its own.
 *
 * `consume` takes `now` as a parameter precisely so this is testable without
 * fake timers, and the cases that matter are the boundaries: the call that
 * exhausts the allowance, the call after it, and the first call of the next
 * window.
 */
describe('ProbeRateLimiter (#338)', () => {
  const T0 = Date.parse('2026-08-26T09:00:00.000Z');
  const HOUR = 60 * 60 * 1000;

  it('permits exactly the limit inside one window', () => {
    const limiter = new ProbeRateLimiter({ limit: 3, windowMs: HOUR });

    const decisions = [0, 1, 2, 3].map(() => limiter.consume('p', T0));

    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
  });

  it('counts down the remaining allowance so the UI can show it', () => {
    const limiter = new ProbeRateLimiter({ limit: 3, windowMs: HOUR });

    expect(limiter.consume('p', T0).state.remaining).toBe(2);
    expect(limiter.consume('p', T0).state.remaining).toBe(1);
    expect(limiter.consume('p', T0).state.remaining).toBe(0);
    expect(limiter.consume('p', T0).state.remaining).toBe(0);
  });

  it('reports when the allowance comes back, counting down as the window runs', () => {
    const limiter = new ProbeRateLimiter({ limit: 1, windowMs: HOUR });

    expect(limiter.consume('p', T0).state.resetSeconds).toBe(3600);
    expect(limiter.consume('p', T0 + 40 * 60 * 1000).state.resetSeconds).toBe(
      20 * 60,
    );
  });

  it('opens a new window once the old one has fully elapsed', () => {
    const limiter = new ProbeRateLimiter({ limit: 1, windowMs: HOUR });
    limiter.consume('p', T0);

    // One millisecond short is still the old window; the boundary itself is
    // the new one. Asserted on both sides, because an off-by-one here is the
    // difference between a limit of N and a limit of 2N.
    expect(limiter.consume('p', T0 + HOUR - 1).allowed).toBe(false);
    expect(limiter.consume('p', T0 + HOUR).allowed).toBe(true);
  });

  it('keeps a separate allowance per key', () => {
    const limiter = new ProbeRateLimiter({ limit: 1, windowMs: HOUR });

    expect(limiter.consume('claude-credential', T0).allowed).toBe(true);
    expect(limiter.consume('supervisor-model', T0).allowed).toBe(true);
    expect(limiter.consume('claude-credential', T0).allowed).toBe(false);
  });

  it('reports the policy itself, so a refusal can explain the rule', () => {
    const limiter = new ProbeRateLimiter({ limit: 5, windowMs: HOUR });

    expect(limiter.consume('p', T0).state).toMatchObject({
      limit: 5,
      windowSeconds: 3600,
    });
  });

  it('defaults to five per hour', () => {
    expect(DEFAULT_PROBE_RATE_LIMIT).toEqual({ limit: 5, windowMs: HOUR });
  });
});
