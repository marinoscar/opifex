import type {
  SilenceVerdict,
  StreamingFidelity,
  WatchedRunState,
} from './watchdog.types';

/**
 * How long a run may go quiet before it is silent, by declared fidelity.
 *
 * VISION §6 calls this degrading gracefully — *"it gets dumber, not broken."*
 * A single global threshold is the trap #54 names: applied to a non-streaming
 * runner it kills healthy runs constantly, and applied to a streaming one it
 * takes hours to notice a stall, which is the original complaint.
 *
 * The numbers, and why each is what it is:
 *
 * - `full` — the runner emits heartbeats, so silence is genuinely abnormal.
 *   90 seconds is several missed heartbeats, not one hiccup.
 * - `partial` — coarse progress only, so gaps between phases are normal.
 *   Ten minutes tolerates a long build without tolerating a stall.
 * - `none` — nothing but git. Liveness arrives when a commit lands, and a
 *   runner can legitimately think for a long time before committing anything.
 *   Ninety minutes is deliberately generous: for this runner a false kill is
 *   far more likely than a missed stall, and the git watcher will surface
 *   real progress the moment it happens.
 */
export const SILENCE_THRESHOLDS_MS: Record<StreamingFidelity, number> = {
  full: 90_000,
  partial: 10 * 60_000,
  none: 90 * 60_000,
};

/**
 * The threshold for a runner that has declared nothing.
 *
 * Matches the most permissive tier rather than the strictest. An unregistered
 * runner is an operational gap, and killing its runs is the wrong way to
 * report one — the run is doing real work, and the missing manifest is a
 * separate problem with its own fix.
 */
export const UNDECLARED_THRESHOLD_MS = SILENCE_THRESHOLDS_MS.none;

/** Statuses a silence verdict can apply to. */
const JUDGEABLE: readonly string[] = ['running', 'stalled'];

/**
 * Find the runs that have gone silent.
 *
 * VISION §1's origin story, and the failure that started the project:
 *
 * > A session stalls at 10am. I find out at 2pm. Four hours dead.
 *
 * Pure and deterministic — `now` is a parameter rather than read from the
 * clock, so a test can place a run at an exact age and the same inputs always
 * produce the same verdicts. VISION §7 puts stall detection firmly in the hot
 * path, with no model involvement: this is arithmetic on timestamps, and it
 * has to stay that way.
 */
export function detectSilentRuns(
  runs: WatchedRunState[],
  now: Date,
): SilenceVerdict[] {
  const verdicts: SilenceVerdict[] = [];

  for (const run of runs) {
    // A blocked run is parked with a reset time and is SUPPOSED to be quiet
    // (#56). Judging it as silent would kill exactly the runs the system is
    // successfully waiting out — collapsing two of VISION §9's three failure
    // modes into one, which it calls the most common supervision bug.
    if (!JUDGEABLE.includes(run.status)) continue;

    const thresholdMs = thresholdFor(run.fidelity);

    // A run that has never reported is measured from when it STARTED. Treating
    // "no events yet" as infinitely old would kill every run in the seconds
    // between dispatch and its first heartbeat.
    const since = run.lastEventAt ?? run.startedAt;
    const silentForMs = now.getTime() - since.getTime();

    if (silentForMs <= thresholdMs) continue;

    verdicts.push({
      runId: run.runId,
      workOrderIdentity: run.workOrderIdentity,
      repository: run.repository,
      issueNumber: run.issueNumber,
      silentForMs,
      thresholdMs,
      fidelity: run.fidelity,
      progressStoppedAt: since,
      // Null when the run never reported: nothing has ever seen it alive, so
      // naming a source would claim an observation that did not happen.
      detectionSource: run.lastEventAt ? run.lastEventSource : null,
      reason: describe(run, silentForMs, thresholdMs),
    });
  }

  return verdicts;
}

export function thresholdFor(fidelity: StreamingFidelity | null): number {
  return fidelity === null
    ? UNDECLARED_THRESHOLD_MS
    : SILENCE_THRESHOLDS_MS[fidelity];
}

/**
 * The sentence a human reads when a run is killed.
 *
 * Names the observed age, the threshold, and where the threshold came from,
 * because this is the one decision in the system that destroys work — and a
 * verdict nobody can check is one they will eventually stop trusting.
 */
function describe(
  run: WatchedRunState,
  silentForMs: number,
  thresholdMs: number,
): string {
  const observed = run.lastEventAt
    ? `last event of any source at ${run.lastEventAt.toISOString()}`
    : `no event of any source since the run started at ${run.startedAt.toISOString()}`;

  const basis =
    run.fidelity === null
      ? `${run.runnerKey} has declared no capability manifest, so the most permissive threshold applies`
      : `${run.runnerKey} declares ${run.fidelity} streaming fidelity`;

  return (
    `silent for ${formatDuration(silentForMs)} (${observed}), exceeding the ` +
    `${formatDuration(thresholdMs)} threshold: ${basis}`
  );
}

/**
 * A duration a human can check the verdict against.
 *
 * Exported because the check-coverage report (#104) states the same
 * thresholds to the same operator, and two renderings of one number is the
 * cheapest possible way to make them look like two different numbers.
 *
 * Rounding to whole minutes on both sides produced "silent for 2m, exceeding
 * the 2m threshold" for a 95-second silence against a 90-second threshold — a
 * justification that cannot justify itself, and precisely the kind of number
 * that makes an operator stop trusting a kill. Under an hour, seconds are
 * always shown.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins < 60) return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;

  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
