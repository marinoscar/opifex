import type { SnapshotTotals } from '../snapshot/snapshot.types';

/**
 * When the supervisor must stand down (#89).
 *
 * ## The reason changed. The gate did not.
 *
 * This file used to justify itself with VISION §7's "It consumes the same
 * quota as the workers, and a supervisor competing for the quota it is
 * managing is a bad loop." That sentence was a factual claim about which
 * budget an invocation spends from, and ADR-0015 made it false: the supervisor
 * now calls a separately metered API key of its own rather than the agent
 * subscription `claude-code-local` authenticates with, so an invocation no
 * longer competes with a worker for anything a worker needs.
 *
 * **The gate stays exactly as it was, on a different fact.** A parked worker
 * is evidence that everything the supervisor exists to advise about has
 * stopped moving. Diagnosis produced while every run is stalled has nothing
 * live to act on it — the daily brief says the same thing whether it is
 * computed now or once runs resume, and a re-dispatch or decomposition
 * proposal has no target that can execute on it until a worker is unblocked.
 * Standing down is no longer protecting a budget; there is simply nothing
 * worth diagnosing while everything is parked.
 *
 * The old reason is recorded here rather than deleted because a comment that
 * used to be true is worse than no comment at all: a reader who found the gate
 * and the old justification together would take one as the explanation of the
 * other and reason onwards from a false premise.
 *
 * ## What "everything is parked" is measured by, and what it is not
 *
 * VISION §11's shared quota is the agent subscription, and nothing in this
 * system measures it — `metrics.service.ts` says so and refuses to substitute
 * the GitHub rate limit for it, because "labelling one 'Quota burn' while
 * measuring the other is the same substitution wearing a better disguise".
 * That refusal applies here too, and it is why this gate reads STATE rather
 * than any budget: a run parked in `blocked` is a worker that hit a rate limit
 * and is waiting to resume. That is not a proxy for what anyone has left to
 * spend — it is a fact about work having stopped.
 *
 * The second signal is pressure rather than exhaustion: with many runs live,
 * the marginal call is more likely to be the one that tips a worker into
 * parking. That threshold is configurable and defaults generously, because a
 * gate that fires constantly is a supervisor that never runs.
 */

export interface QuotaGateConfig {
  /**
   * Stand down when any run is parked on a rate limit.
   *
   * Defaults ON. A parked worker is the clearest evidence available that the
   * work the supervisor would be diagnosing is not moving, and an hour's
   * diagnosis nobody can act on costs more than it is worth.
   */
  standDownWhenBlocked: boolean;
  /**
   * Stand down when at least this many runs are live.
   *
   * Null disables the check. Live means `running` — work actually consuming
   * the subscription right now.
   */
  liveRunCeiling: number | null;
}

export const DEFAULT_QUOTA_GATE: QuotaGateConfig = Object.freeze({
  standDownWhenBlocked: true,
  liveRunCeiling: null,
});

export interface QuotaVerdict {
  /** Whether the supervisor should skip this invocation entirely. */
  standDown: boolean;
  /**
   * Why, in words that go into the log.
   *
   * Null when the supervisor may proceed. A skipped invocation with no stated
   * reason is a gap in the log, and #90 requires the log have none: a missing
   * entry is indistinguishable from an invocation that silently failed.
   */
  reason: string | null;
}

/**
 * Decide whether to run.
 *
 * PURE, and takes the totals the snapshot already computed rather than
 * querying. The gate must not itself cost a round trip on a system already
 * judged to be under pressure, and being pure means the decision that produced
 * a `skipped_quota` row is reconstructable from the row.
 */
export function assessQuota(
  totals: Pick<SnapshotTotals, 'runsBlocked' | 'runsRunning'>,
  config: QuotaGateConfig = DEFAULT_QUOTA_GATE,
): QuotaVerdict {
  if (config.standDownWhenBlocked && totals.runsBlocked > 0) {
    return {
      standDown: true,
      reason:
        `${totals.runsBlocked} run(s) are parked on a rate limit. Diagnosis is worth ` +
        'less than execution, so the supervisor stands down until they resume.',
    };
  }

  if (
    config.liveRunCeiling !== null &&
    totals.runsRunning >= config.liveRunCeiling
  ) {
    return {
      standDown: true,
      reason:
        `${totals.runsRunning} run(s) are live, at or above the ceiling of ` +
        `${config.liveRunCeiling}. The supervisor yields the shared quota to the workers.`,
    };
  }

  return { standDown: false, reason: null };
}
