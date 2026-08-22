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
  /** The runner's key, for the record. */
  runnerKey: string;
  /**
   * The runner's declared streaming fidelity, or null when it has registered
   * no capability manifest at all.
   */
  fidelity: StreamingFidelity | null;
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
   * Why, naming the numbers.
   *
   * #54: "Every kill records why, with the event age that triggered it." A
   * verdict a human cannot check is one they will eventually stop trusting,
   * and this is the one decision in the system that destroys work.
   */
  reason: string;
}
