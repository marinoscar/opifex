/**
 * What one tick did, recorded whether or not it found anything to do.
 *
 * #45 requires duration and outcome be recorded so tick latency is measurable —
 * VISION §13 says to add webhooks only when tick latency *demonstrably* hurts,
 * and "demonstrably" needs a number. #50 persists these; this is the shape.
 */
export interface TickRecord {
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  outcome: TickOutcome;
  /** Repositories observed this tick. */
  repositoriesObserved: number;
  /** Repositories that failed to observe, with the reason. */
  failures: TickFailure[];
  /**
   * True when every GitHub read this tick was answered from the ETag cache —
   * the tick cost no rate-limit budget at all. Worth recording because it is
   * the number that says whether polling is affordable (#40).
   */
  allFromCache: boolean;
  /** Rate-limit budget remaining when the tick finished, if known. */
  rateLimitRemaining: number | null;
}

export type TickOutcome =
  /** Ran to completion. */
  | 'completed'
  /** Another tick held the lease. Expected, not a fault. */
  | 'skipped-locked'
  /** The reconciler is switched off. */
  | 'skipped-disabled'
  /**
   * Stopped early because the GitHub budget ran out.
   *
   * A distinct outcome rather than a failure: the tick behaved correctly, and
   * conflating it with an error would make a healthy rate-limited system look
   * broken in the log the observation week is reviewed from.
   */
  | 'skipped-rate-limited'
  /** At least one repository failed to observe. */
  | 'partial'
  /** The tick itself threw. */
  | 'failed';

export interface TickFailure {
  repository: string;
  reason: string;
}
