import type { ReconcileAction } from './diff/actions.types';
import type { DesiredState } from './projection/desired-state.types';
import type { RejectedIssue } from '../work-orders/work-order-projection.service';

/**
 * An issue whose spec the generator refused, and where to say so.
 *
 * Carried off the tick rather than acted on inside it, for the same reason
 * actions are: the component that DECIDES an issue is unbuildable must not be
 * the one that comments on it. `ReconcilerTask` is where computing meets
 * acting, and it is the only place that may post.
 */
export interface TickRejection extends RejectedIssue {
  repository: { id: string; owner: string; name: string };
  /** Whether this repository has opted in to receiving spec feedback. */
  feedbackEnabled: boolean;
}

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
  /**
   * What the tick computed SHOULD be true, one entry per repository observed.
   *
   * Carried on the record because it is the deliverable of VISION §12's
   * observation week, not a debugging aid: reviewing what the reconciler
   * concluded, before it could act on any of it, is the whole point of the
   * week. #50 persists these.
   */
  projections: DesiredState[];
  /**
   * Work orders this tick created, across every repository.
   *
   * A count rather than the documents: the rows are the record, and copying
   * them onto the tick log would duplicate an authorization document into a
   * second place it could drift from.
   */
  workOrdersCreated: number;
  /**
   * Issues whose spec was rejected, for the task to report once each.
   *
   * VISION §10 makes spec quality the throughput ceiling — *the factory cannot
   * be better than what it is told to build* — so a rejection is a message to
   * a human, not a log line, and it has to survive the tick to become one.
   */
  rejections: TickRejection[];
  /**
   * What the tick decided to do — and, during the observation week, did NOT do.
   *
   * VISION §12: "Every tick records what it observed, what it computed, and
   * what it would have done." This is the third of those, and reviewing it is
   * how the week's exit criterion is met.
   */
  actions: ReconcileAction[];
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
