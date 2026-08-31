import type { ReconcileAction } from '../reconciler/diff/actions.types';

/**
 * WHAT `Run.resumesAt` MEANS, AND WHO IS ALLOWED TO WRITE IT (#477)
 *
 * ## The collision
 *
 * The column carried two incompatible meanings and had two writers.
 * `RunEventsService.blockRun` wrote it as *the vendor's reset instant*;
 * {@link decideParking} and `DispatchService.quotaPositions` read it as *our
 * jittered plan*; `WatchdogService.sweepBlocked` wrote that plan on a `park`.
 * The first writer always won, because the function below short-circuits to
 * `waiting` whenever `resumesAt` is in the future — so a dated block never
 * reached `park` at all, and {@link JITTER_FRACTION} was never applied to one.
 *
 * That is not a tidiness problem. The jitter is the only thing standing
 * between one quota window and a thundering herd: every run parked by the same
 * window would have carried the same unjittered instant and woken together,
 * re-exhausting the quota immediately. It was inert only for as long as
 * nothing consumed the resume action, which #477 changes.
 *
 * ## The decision, and why this one
 *
 * **`resumesAt` means OUR PLAN: the instant this control plane intends to
 * re-invoke the runner, jitter already applied.** The watchdog is the only
 * component that computes one, and the vendor's raw reset stays where it was
 * always first-hand — on the `run_blocked` event row as `blockedUntil`.
 *
 * Three options were on the table and the other two lose on the same ground.
 *
 *  - *Keep it meaning the vendor's reset and add a column for the plan.*
 *    Honest, and it leaves two dates to keep straight in every reader forever
 *    — plus a migration to introduce a value one of them can already derive.
 *    The plan is a function of the reset; the reset is not a function of the
 *    plan. Storing both makes them independently corruptible.
 *  - *Keep both writers and teach `decideParking` to tell an unjittered value
 *    from a planned one.* That needs a flag saying which of the two meanings
 *    the column currently holds, which is the second column wearing a
 *    disguise, and it leaves the ambiguity in the data rather than removing
 *    it.
 *
 * What settles it is that a plan and an observation are different KINDS of
 * fact. The vendor's reset is something a runner reported and `run_events` is
 * append-only, so it is already recorded, immutable, and read by both readers
 * that need it (`loadBlockedRuns` takes `resetAt` from the event;
 * `quotaPositions` takes `blockedUntil` from the event and falls back to the
 * run only to be patient). A plan is something Opifex INTENDS, it is revised,
 * and it is erased the moment it is overtaken. Those want different homes.
 *
 * ## The invariant, stated so it can be checked
 *
 *  1. Exactly one component COMPUTES a resume plan: the watchdog, in
 *     {@link decideParking}, persisted by `WatchdogService.sweepBlocked`.
 *  2. Anything that observes the park ENDING clears it to null —
 *     `RunExecutorService.resumeParkedRun` when it wakes the run, and
 *     `RunEventsService.resumeRun` when the run wakes on its own. That is not
 *     a second writer of the meaning: `null` says "there is no plan", which
 *     is a fact any observer of the ending can state, and two of them cannot
 *     disagree about it.
 *  3. Nothing else writes it. In particular ingestion does not, which is the
 *     change #477 made to `blockRun`.
 *
 * The cost, accepted: a just-blocked run has a null `resumesAt` until the next
 * watchdog tick plans one — up to one tick interval where the cockpit says no
 * resume is scheduled, because none is. Routing is unaffected; it reads the
 * event's `blockedUntil` and only prefers the run's plan when the plan is
 * later.
 *
 * The declaration in `schema.prisma` still describes the OLD meaning ("ISO
 * reset time for a blocked run… the watchdog resumes at this time plus
 * jitter"). It needs to say what this comment says; that edit belongs to the
 * schema's owner and is tracked as follow-up on #477.
 */

/** A run that reported itself blocked. */
export interface BlockedRunState {
  runId: string;
  workOrderIdentity: string;
  repository: string;
  issueNumber: number;
  /** When the run reported the block. */
  blockedSince: Date;
  /**
   * The reset time the runner supplied, or null when it could not say.
   *
   * Read from the `run_blocked` EVENT, which is the only place it is written
   * since #477. See the module comment above.
   */
  resetAt: Date | null;
  /** The structured reason, for the record. */
  reason: string | null;
  /**
   * The resume this control plane has already planned, jitter included.
   *
   * Null until a tick plans one — including for a run that blocked seconds
   * ago, which is the state that makes a dated block reach `park` and get its
   * jitter. See the module comment above for the whole of that argument.
   */
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
  // An existing plan is honoured unless the block it was drawn from has been
  // SUPERSEDED. A runner that hits a five-hour wall and then a weekly one
  // reports a second, later reset; a plan drawn from the first would wake the
  // run before the second window has rolled and it would re-block instantly —
  // the loop the jitter exists to prevent, arrived at from the other side.
  //
  // This check moved here from ingestion in #477. It used to be implicit:
  // `RunEventsService.blockRun` overwrote `resumesAt` with each new reset, so
  // a superseding block re-dated the park as a side effect of parking it. Now
  // that the column means OUR PLAN and the watchdog is its only writer (see
  // the module comment), the supersession has to be noticed here — by the
  // component that owns the plan — rather than upstream by the component that
  // owns the observation.
  //
  // `>` and not `>=`: a plan is always the reset PLUS jitter, so a plan drawn
  // from this very reset is strictly later than it. Only a reset that has
  // overtaken the plan can be a newer one.
  const superseded =
    run.resumesAt !== null &&
    run.resetAt !== null &&
    run.resetAt > run.resumesAt;

  if (run.resumesAt && !superseded) {
    // Already scheduled and not yet due. Re-deciding every tick would move the
    // resume time on each pass and the run would never actually resume — the
    // jitter would chase itself.
    if (run.resumesAt > now) {
      return {
        kind: 'waiting',
        reason: `parked until ${run.resumesAt.toISOString()} (${run.reason ?? 'reason not reported'})`,
      };
    }

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
      `${superseded ? 're-park' : 'park'} ${run.workOrderIdentity} until ` +
      `${resumeAt.toISOString()}: blocked on '${run.reason ?? 'unknown'}' resetting at ` +
      `${run.resetAt.toISOString()}` +
      (superseded
        ? `, which supersedes the ${run.resumesAt?.toISOString()} already planned`
        : '') +
      `, plus ${Math.round(jitterMs / 1000)}s jitter so simultaneously-parked runs do not ` +
      'resume together',
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
      // The resume ACTION is computed here and EXECUTED by
      // `reconciler/execute/resume.executor.ts`, which hands it to
      // `RunExecutorService.resumeParkedRun` (#477). This comment used to say
      // the dispatch half arrives with #66; #66 closed on 2026-08-23 with that
      // criterion unmet, which is the gap #477 exists to close.
      //
      // The split is deliberate rather than historical. Deciding that a park
      // is over is arithmetic over dates and belongs in a pure function; doing
      // something about it spends real money against a real subscription with
      // nobody watching, and VISION §12 keeps that out of the component that
      // decides.
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
