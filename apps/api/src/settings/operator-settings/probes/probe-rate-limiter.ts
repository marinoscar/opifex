/**
 * A fixed-window counter for the probes that spend real money (#338).
 *
 * ## Why this exists at all
 *
 * `claude-credential` and `supervisor-model` are the only two probes worth
 * having, and the reason is the same reason they need a limiter: they exercise
 * the credential. `claude --version` succeeds without one, so a `--version`
 * probe reports an unauthenticated CLI as a healthy runner that will then fail
 * every dispatch at auth — which is the deceptive failure the issue is written
 * around. A probe that proves the credential works has to make a real call, and
 * a real call costs a real fraction of a real quota. A Test button with no
 * ceiling is a button an impatient operator (or a UI with a retry loop) can
 * hold down until the quota the factory runs on is gone.
 *
 * ## Why the limit is global rather than per user
 *
 * The thing being protected is one quota and one bill, not one person's
 * fairness share. VISION §11 has this system as single-operator by design;
 * two admins clicking Test are spending the same money as one admin clicking
 * it twice, and a per-user bucket would let N admins spend N times the ceiling
 * for no reason anybody could state.
 *
 * ## Why a fixed window and not a token bucket
 *
 * The window is what the response has to EXPLAIN — "3 of 5 left, resets in 47
 * minutes" is a sentence a UI can render and an operator can act on. A token
 * bucket's continuous refill is more elegant and describes worse: there is no
 * moment to point at. The issue requires the limit be stated in the response,
 * which makes explicability the property to optimise for.
 *
 * ## Why in memory
 *
 * The ceiling is per process, and this codebase runs one API process. A shared
 * counter would need the database on the path of a probe that exists to be
 * usable when things are broken. If a deployment ever runs two API replicas,
 * the honest statement is that each gets its own budget — and that is written
 * here rather than discovered.
 */

/** What a caller is told about its allowance, whether or not it was spent. */
export interface ProbeRateLimitState {
  /** Calls permitted per window. */
  readonly limit: number;
  /** The window's length. */
  readonly windowSeconds: number;
  /** Calls still available in the current window, after this one. */
  readonly remaining: number;
  /** Seconds until the window resets. */
  readonly resetSeconds: number;
}

export interface ProbeRateLimitDecision {
  readonly allowed: boolean;
  readonly state: ProbeRateLimitState;
}

export interface ProbeRateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * Five per hour, per probe.
 *
 * Chosen from what the button is for rather than from a round number: an
 * operator pasting a credential, finding a typo, fixing it and confirming is
 * three or four calls, and five leaves room for one more without leaving room
 * for a loop. An hour is short enough that being locked out is a coffee rather
 * than a day.
 */
export const DEFAULT_PROBE_RATE_LIMIT: ProbeRateLimitPolicy = {
  limit: 5,
  windowMs: 60 * 60 * 1000,
};

interface Window {
  startedAt: number;
  used: number;
}

export class ProbeRateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly policy = DEFAULT_PROBE_RATE_LIMIT) {}

  /**
   * Consume one call if there is one, and report the allowance either way.
   *
   * `now` is a parameter rather than a `Date.now()` inside, so the window
   * boundary is testable without faking timers — the same reason
   * `DispatchService.decide()` takes its instant from its caller.
   */
  consume(key: string, now: number = Date.now()): ProbeRateLimitDecision {
    const window = this.currentWindow(key, now);
    const elapsed = now - window.startedAt;
    const resetSeconds = Math.max(
      0,
      Math.ceil((this.policy.windowMs - elapsed) / 1000),
    );

    if (window.used >= this.policy.limit) {
      return {
        allowed: false,
        state: {
          limit: this.policy.limit,
          windowSeconds: Math.round(this.policy.windowMs / 1000),
          remaining: 0,
          resetSeconds,
        },
      };
    }

    window.used += 1;

    return {
      allowed: true,
      state: {
        limit: this.policy.limit,
        windowSeconds: Math.round(this.policy.windowMs / 1000),
        remaining: this.policy.limit - window.used,
        resetSeconds,
      },
    };
  }

  /** For a spec, and for a process that wants a clean slate. */
  reset(): void {
    this.windows.clear();
  }

  private currentWindow(key: string, now: number): Window {
    const existing = this.windows.get(key);

    if (
      existing === undefined ||
      now - existing.startedAt >= this.policy.windowMs
    ) {
      const fresh: Window = { startedAt: now, used: 0 };
      this.windows.set(key, fresh);
      return fresh;
    }

    return existing;
  }
}
