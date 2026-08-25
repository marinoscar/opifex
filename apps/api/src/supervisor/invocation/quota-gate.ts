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
 * ## There was a second arm, and ADR-0016 removed it
 *
 * A `liveRunCeiling` used to stand the supervisor down once `runsRunning`
 * reached a configured threshold. Its stated reason was rewritten twice — from
 * "the supervisor yields the shared quota to the workers", which ADR-0015
 * falsified, to "there is little worth diagnosing while that much is still in
 * flight" — without anyone deciding whether the arm should exist. ADR-0016
 * decided: it should not. `runsRunning` is not evidence about anything the
 * ceiling could legitimately stand down for. It is not a cost control, because
 * `SupervisorService.invoke()` runs every proposer exactly once per tick
 * regardless of how many runs are live, and the one proposer with a bounded
 * call count caps against `attentionRuns` — runs that are stalled, blocked or
 * quarantined — not against `runsRunning`. It is not a staleness control
 * either, because a diagnosis of a run stalled for six hours does not go stale
 * because fifty other healthy runs happen to be moving.
 *
 * That is recorded here rather than dropped because the removal is the
 * decision: a future PR wanting a throttle in this file should read ADR-0016
 * and argue past it, not rediscover the same proxy. If the concern is dollars,
 * the honest mechanism is a spend ceiling in the shape of
 * `hard-spend-ceiling.ts` (#261), which bounds the thing it claims to bound.
 *
 * What survives the removal is the one signal that never used `runsRunning`:
 * `runsBlocked > 0` is a direct fact that work has stopped, not a proxy for
 * one.
 */

export interface QuotaGateConfig {
  /**
   * Stand down when any run is parked on a rate limit.
   *
   * Defaults ON. A parked worker is the clearest evidence available that the
   * work the supervisor would be diagnosing is not moving, and an hour's
   * diagnosis nobody can act on costs more than it is worth.
   *
   * The only field, since ADR-0016. Anything added beside it needs its own
   * argued decision rather than a config key restored because nothing noticed
   * the last one had gone.
   */
  standDownWhenBlocked: boolean;
}

export const DEFAULT_QUOTA_GATE: QuotaGateConfig = Object.freeze({
  standDownWhenBlocked: true,
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
 *
 * Takes only `runsBlocked` since ADR-0016. The narrower parameter is the
 * point: the gate cannot regrow a `runsRunning` branch without the signature
 * changing in a diff.
 */
export function assessQuota(
  totals: Pick<SnapshotTotals, 'runsBlocked'>,
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

  return { standDown: false, reason: null };
}
