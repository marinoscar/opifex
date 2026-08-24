/**
 * The input to the supervisor snapshot renderer (#88).
 *
 * VISION §7: "The supervisor holds **no state in its context**. Postgres holds
 * state; the supervisor receives a rendered snapshot at invocation and returns
 * a proposal."
 *
 * These are PLAIN VALUES, deliberately — not Prisma rows, not entities with
 * methods. The renderer must be a pure function of this object so a stored
 * snapshot can be replayed byte-for-byte a month later, and a Prisma row
 * carries lazily-loaded relations and Decimal instances that make that
 * impossible to guarantee. `SnapshotService` does the narrowing; the renderer
 * never sees a client.
 */

/** How the factory as a whole is doing, in the numbers the supervisor needs. */
export interface SnapshotTotals {
  /** Runs currently `running`. */
  runsRunning: number;
  /** Runs currently `stalled` — silent past their threshold. */
  runsStalled: number;
  /** Runs currently `blocked` — parked on a rate limit, auto-resuming. */
  runsBlocked: number;
  /** Runs that concluded `succeeded` inside the window. */
  runsSucceededInWindow: number;
  /** Runs that concluded `failed` inside the window. */
  runsFailedInWindow: number;
  /** Work orders in `queued`, waiting their turn. */
  workOrdersQueued: number;
  /** Work orders in `held` — a `factory:hold` label or an approval gate. */
  workOrdersHeld: number;
  /** Work orders in `quarantined`. By VISION §8 only a human clears these. */
  workOrdersQuarantined: number;
  /** Escalations raised but not yet acknowledged. */
  escalationsOutstanding: number;
}

/** One run the supervisor may be asked to reason about. */
export interface SnapshotRun {
  /** The run's uuid. The stable identifier a proposal refers back to. */
  id: string;
  /** The work order's deterministic identity, e.g. `wo_opifex_312_a3f91c2_a1`. */
  workOrderIdentity: string;
  /** `owner/name`, so the supervisor can tell repositories apart. */
  repository: string;
  issueNumber: number;
  issueTitle: string | null;
  status: string;
  runnerKey: string;
  startedAt: Date;
  endedAt: Date | null;
  /** Last event of any source. Null until the first one arrives. */
  lastEventAt: Date | null;
  /** How many times the runner has been invoked for this run. */
  attemptCount: number;
  /**
   * Cumulative spend, or null when the runner reports no cost at all.
   *
   * A NUMBER here rather than a Decimal, and nullable rather than defaulted:
   * VISION §6 makes cost reporting a declared capability, so "unknown" and
   * "zero" are genuinely different and must not both render as `$0`.
   */
  costUsd: number | null;
  /** What the watchdog concluded, when a human must act. */
  attentionReason: string | null;
  /** Why the run stopped, in the runner's own words. */
  stopReason: string | null;
  pullRequestNumber: number | null;
  /** `merged`, `closed`, or null while the pull request is still open. */
  pullRequestState: string | null;
}

/** One work order the supervisor may be asked to reason about. */
export interface SnapshotWorkOrder {
  identity: string;
  repository: string;
  issueNumber: number;
  issueTitle: string | null;
  status: string;
  /** 1-based, and part of the identity: attempt 3 means two were abandoned. */
  attempt: number;
  /** How many acceptance criteria the order carries. Zero is a spec smell. */
  acceptanceCriteriaCount: number;
  createdAt: Date;
}

/**
 * One issue the deterministic spec gate turned away (#62).
 *
 * The truest signal of an under-specified issue available anywhere in this
 * system: not a guess from the text, but a record that the gate REFUSED to
 * project a work order from it and told the author why. #111 calls the gate
 * "a floor, not feedback" — it says no without saying what yes looks like —
 * and this is what lets the supervisor answer the second half.
 */
export interface SnapshotSpecRejection {
  repository: string;
  issueNumber: number;
  /** What the author was told, verbatim. */
  message: string;
  rejectedAt: Date;
}

/** One outstanding escalation. */
export interface SnapshotEscalation {
  id: string;
  kind: string;
  status: string;
  summary: string;
  raisedAt: Date;
  /** The run it is about, or null for a `system` escalation. */
  runId: string | null;
}

/**
 * Everything the supervisor gets to know at one invocation.
 *
 * Assembled by `SnapshotService` and rendered by `renderSnapshot`. Both halves
 * are stored: the rendered text is what the model saw, and this object is what
 * it was rendered from.
 */
export interface SnapshotInput {
  /**
   * The instant the snapshot describes.
   *
   * PASSED IN, never read from the clock inside the renderer. Ages are
   * rendered relative to this, so a stored snapshot re-renders identically
   * however long afterwards it is replayed — which is what makes #90's "what
   * did it actually know?" a question with an answer.
   */
  generatedAt: Date;
  /** How many days back the windowed counts cover. */
  windowDays: number;
  totals: SnapshotTotals;
  /** Runs wanting attention, most in need first. */
  attentionRuns: SnapshotRun[];
  /** Runs that concluded inside the window, newest first. */
  recentRuns: SnapshotRun[];
  /** Work orders waiting to be dispatched, oldest first. */
  queuedWorkOrders: SnapshotWorkOrder[];
  /** Work orders in quarantine, oldest first. */
  quarantinedWorkOrders: SnapshotWorkOrder[];
  /** Outstanding escalations, oldest first. */
  escalations: SnapshotEscalation[];
  /** Issues the spec gate rejected, most recent first. */
  specRejections: SnapshotSpecRejection[];
}

/**
 * Per-section row caps.
 *
 * Bounding by SECTION rather than by total character count, on purpose. A
 * global budget spent front-to-back means a bad day full of stalled runs
 * silently pushes the queue out of the snapshot entirely, and the supervisor
 * then reasons about a factory that appears to have nothing waiting. Fixed
 * per-section caps make the worst case a known shape rather than an emergent
 * one.
 */
export interface SnapshotLimits {
  attentionRuns: number;
  recentRuns: number;
  queuedWorkOrders: number;
  quarantinedWorkOrders: number;
  escalations: number;
  specRejections: number;
  /** Longest single free-text field before it is elided, in characters. */
  textField: number;
}

/**
 * The defaults.
 *
 * Sized for a small model with room left to reason: at these caps a fully
 * saturated snapshot is roughly 6–8 KB of text. The numbers are deliberately
 * uneven — the sections a proposal is most often about get more rows.
 */
export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = Object.freeze({
  attentionRuns: 15,
  recentRuns: 20,
  queuedWorkOrders: 15,
  quarantinedWorkOrders: 10,
  escalations: 10,
  specRejections: 10,
  textField: 240,
});

/** What the renderer produces. */
export interface RenderedSnapshot {
  /** The text handed to the model. */
  text: string;
  /** True if any section dropped rows. Stored so bias is visible in review. */
  truncated: boolean;
  /** Which sections dropped rows, and how many. Empty when nothing was cut. */
  truncatedSections: TruncationNote[];
  /** `text.length`. Recorded so context growth is measurable over time. */
  characters: number;
}

/** One section that did not fit. */
export interface TruncationNote {
  section: string;
  shown: number;
  total: number;
}
