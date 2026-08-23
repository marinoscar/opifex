import type { ReconcileAction } from '../reconciler/diff/actions.types';

/** A run that reported itself blocked. */
export interface BlockedRunState {
  runId: string;
  workOrderIdentity: string;
  repository: string;
  issueNumber: number;
  /** When the run reported the block. */
  blockedSince: Date;
  /** The reset time the runner supplied, or null when it could not say. */
  resetAt: Date | null;
  /** The structured reason, for the record. */
  reason: string | null;
  /** The resume already scheduled, if a previous tick scheduled one. */
  resumesAt: Date | null;
}

export type ParkingDecision =
  /** Schedule a resume at the reset time plus jitter. */
  | { kind: 'park'; resumeAt: Date; reason: string }
  /** Its scheduled time has arrived. */
  | { kind: 'resume'; reason: string }
  /** Already parked with a future resume; nothing to do. */
  | { kind: 'waiting'; reason: string }
  /** No reset time and it has waited too long. A human must look. */
  | { kind: 'escalate'; reason: string };

/**
 * The jitter window applied to every resume.
 *
 * ## This is load-bearing, not politeness
 *
 * #56 states the failure directly: every run parked by the same quota window
 * would otherwise resume in the same instant and re-exhaust the quota
 * immediately, converting one block into a thundering-herd loop.
 *
 * The window is proportional rather than fixed. A five-minute block and a
 * four-hour block need different spreads: a fixed 30-second jitter spread
 * across fifty runs still lands them all within one minute of a quota that
 * refills gradually, while a fixed ten minutes would delay a short block far
 * past its reset for no reason.
 */
export const JITTER_FRACTION = 0.1;
export const MIN_JITTER_MS = 15_000;
export const MAX_JITTER_MS = 10 * 60_000;

/**
 * How long a block with NO reset time may sit before a human is told.
 *
 * A run blocked for a reason the runner cannot date still parks — but nothing
 * can compute when it would resume, so parking it forever would be exactly the
 * silent dead time this project exists to eliminate. #56 requires it escalate
 * instead.
 */
export const UNDATED_BLOCK_PATIENCE_MS = 30 * 60_000;

/**
 * Decide what to do about one blocked run.
 *
 * Pure, with `now` and `jitterFraction` as parameters: the jitter is random by
 * nature, so the randomness is injected rather than read, and a test can then
 * assert both the spread and the bounds deterministically.
 */
export function decideParking(
  run: BlockedRunState,
  now: Date,
  random: () => number = Math.random,
): ParkingDecision {
  // Already scheduled and not yet due. Re-deciding every tick would move the
  // resume time on each pass and the run would never actually resume — the
  // jitter would chase itself.
  if (run.resumesAt && run.resumesAt > now) {
    return {
      kind: 'waiting',
      reason: `parked until ${run.resumesAt.toISOString()} (${run.reason ?? 'reason not reported'})`,
    };
  }

  if (run.resumesAt && run.resumesAt <= now) {
    return {
      kind: 'resume',
      reason: `resume ${run.workOrderIdentity}: its scheduled time ${run.resumesAt.toISOString()} has passed`,
    };
  }

  if (!run.resetAt) {
    const waitedMs = now.getTime() - run.blockedSince.getTime();
    if (waitedMs > UNDATED_BLOCK_PATIENCE_MS) {
      return {
        kind: 'escalate',
        reason:
          `${run.workOrderIdentity} has been blocked since ${run.blockedSince.toISOString()} ` +
          `with reason '${run.reason ?? 'unknown'}' and no reset time, so nothing can compute when ` +
          `it would resume. It has waited ${Math.round(waitedMs / 60_000)}m and needs a human.`,
      };
    }
    return {
      kind: 'waiting',
      reason: `blocked with no reset time; waiting ${Math.round(
        (UNDATED_BLOCK_PATIENCE_MS - waitedMs) / 60_000,
      )}m more before escalating`,
    };
  }

  const jitterMs = jitterFor(run.resetAt, run.blockedSince, random);
  const resumeAt = new Date(run.resetAt.getTime() + jitterMs);

  return {
    kind: 'park',
    resumeAt,
    reason:
      `park ${run.workOrderIdentity} until ${resumeAt.toISOString()}: blocked on ` +
      `'${run.reason ?? 'unknown'}' resetting at ${run.resetAt.toISOString()}, plus ` +
      `${Math.round(jitterMs / 1000)}s jitter so simultaneously-parked runs do not resume together`,
  };
}

/**
 * Jitter proportional to how long the block lasts, within bounds.
 *
 * Added AFTER the reset rather than spread around it: resuming before the
 * quota has actually refilled guarantees an immediate second block, which is
 * the loop the jitter exists to prevent.
 */
export function jitterFor(
  resetAt: Date,
  blockedSince: Date,
  random: () => number,
): number {
  const blockDurationMs = Math.max(
    0,
    resetAt.getTime() - blockedSince.getTime(),
  );
  const window = Math.min(
    MAX_JITTER_MS,
    Math.max(MIN_JITTER_MS, blockDurationMs * JITTER_FRACTION),
  );

  return Math.floor(random() * window);
}

/** The action a parking decision implies, in the diff engine's vocabulary. */
export function actionsForParking(
  run: BlockedRunState,
  decision: ParkingDecision,
): ReconcileAction[] {
  const base = {
    repository: run.repository,
    issueNumber: run.issueNumber,
    runId: run.runId,
    evidence: {
      intent: 'blocked' as const,
      inputLabels: [],
      workOrderIdentity: run.workOrderIdentity,
      runStatus: 'blocked',
      currentMirrorLabels: [],
      desiredMirrorLabels: [],
    },
  };

  switch (decision.kind) {
    case 'park':
      return [
        {
          ...base,
          type: 'park',
          resumeAt: decision.resumeAt.toISOString(),
          reason: decision.reason,
        },
      ];
    case 'resume':
      // The resume ACTION is computed here; the resume DISPATCH is wired when
      // Phase 4's dispatch path exists (#66 does that wiring and says so).
      return [{ ...base, type: 'resume', reason: decision.reason }];
    case 'escalate':
      // `system` rather than `run_stalled`: the run is not stalled, it is
      // correctly blocked. What has failed is that nothing can date the
      // block, which is a gap in what the runner reported rather than a
      // problem with the run itself — and an operator triaging these needs to
      // tell those apart.
      return [
        {
          ...base,
          type: 'escalate',
          escalationKind: 'system',
          reason: decision.reason,
        },
      ];
    case 'waiting':
      // The system is working. A blocked run waiting out its quota is Opifex
      // succeeding, and emitting an action every tick would bury the real ones.
      return [];
  }
}
