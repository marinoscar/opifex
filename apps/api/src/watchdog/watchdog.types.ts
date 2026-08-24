import type { RunStatusLike } from '../reconciler/projection/desired-state.types';

/**
 * How much of what a runner is doing Opifex can see.
 *
 * Mirrors `RunnerStreamingFidelity` in schema.prisma. Restated rather than
 * imported for the same reason the projection restates its enums: the
 * detection below must be a pure function over plain data, testable without a
 * database in scope. A spec pins these against the Prisma enum.
 */
export type StreamingFidelity = 'full' | 'partial' | 'none';

/**
 * Which of the two independent liveness sources an observation came from.
 *
 * Mirrors `RunEventSource` in schema.prisma, restated for the same reason the
 * fidelities are: detection must stay a pure function over plain data.
 */
export type LivenessSource = 'runner' | 'git' | 'control_plane';

/** One live run, as the watchdog needs to judge it. */
export interface WatchedRunState {
  runId: string;
  workOrderIdentity: string;
  repository: string;
  issueNumber: number;
  status: RunStatusLike;
  startedAt: Date;
  /**
   * The newest event of ANY source, or null if nothing has ever arrived.
   *
   * Any source is deliberate: a non-streaming runner's only liveness is
   * git-derived (#52), and judging it on runner-reported events alone would
   * starve it of signal and kill it — which #54 explicitly forbids.
   */
  lastEventAt: Date | null;
  /**
   * Which source produced that newest event, or null when none has.
   *
   * VISION §9 runs two INDEPENDENT liveness sources, and #59 requires the
   * detection latency metric say which one was carrying a run when it went
   * quiet. Git-derived detection is structurally slower than runner-reported,
   * and an aggregate that blends them describes neither.
   */
  lastEventSource: LivenessSource | null;

  /** The runner's key, for the record. */
  runnerKey: string;
  /**
   * The runner's declared streaming fidelity, or null when it has registered
   * no capability manifest at all.
   */
  fidelity: StreamingFidelity | null;
  /**
   * The runner's declared rate-limit signal, or null with no manifest.
   *
   * Not used to judge silence — it is carried so the sweep can report which
   * checks COVER each run (#104) without a second query per run. A watchdog
   * that reports what it found but not what it could not look for is the
   * false-confidence failure that issue exists to prevent.
   */
  rateLimitSignal: RateLimitSignal | null;
  /**
   * The branch git-derived liveness would watch, or null when the run has
   * none. The second, independent liveness source exists only where this does.
   */
  branch: string | null;
}

/**
 * What the watchdog concluded about one run.
 *
 * A verdict is not an action. It is the finding, and #54's phase boundary is
 * explicit that the ACTION it implies — kill and re-dispatch from base — is
 * Phase 4 machinery (#61, #66). Until then the computed action escalates.
 */
export interface SilenceVerdict {
  runId: string;
  workOrderIdentity: string;
  repository: string;
  issueNumber: number;
  /** How long the run has been silent, in milliseconds. */
  silentForMs: number;
  /** The threshold it crossed. */
  thresholdMs: number;
  /** Which fidelity produced that threshold, for the record. */
  fidelity: StreamingFidelity | null;
  /**
   * When the run actually stopped making progress.
   *
   * The STOP side of success metric 1. Carried on the verdict rather than
   * recomputed downstream, because the detector is the only component that
   * knows whether it measured from the last event or from the start of a run
   * that never reported at all.
   */
  progressStoppedAt: Date;
  /** Which liveness source last saw the run alive. Null if none ever did. */
  detectionSource: LivenessSource | null;
  /**
   * Why, naming the numbers.
   *
   * #54: "Every kill records why, with the event age that triggered it." A
   * verdict a human cannot check is one they will eventually stop trusting,
   * and this is the one decision in the system that destroys work.
   */
  reason: string;
}

/**
 * How well a runner can report that it has hit a rate limit.
 *
 * Mirrors `RunnerSignalQuality` in schema.prisma, restated for the same reason
 * the fidelities are: the coverage derivation must stay a pure function over
 * plain data. A spec pins these against the Prisma enum.
 *
 * The schema states the consequence rather than leaving it implied:
 * `structured` means a reset time arrives as data and a blocked run can be
 * PARKED with a dated resume (#56); `heuristic` means the reset is inferred
 * from prose, so auto-resume works but is approximate; `none` means "rate
 * limits are not distinguishable — a blocked run escalates."
 */
export type RateLimitSignal = 'structured' | 'heuristic' | 'none';
