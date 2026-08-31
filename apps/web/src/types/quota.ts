/**
 * The quota wire shapes, mirroring `apps/api/src/quota/dto/quota.dto.ts` (the
 * live gauge, #231) and `apps/api/src/quota/dto/quota-history.dto.ts` (the
 * memory, #476).
 *
 * Hand-written rather than generated, for the reason every other type in this
 * folder is: importing the API's zod modules into `apps/web` would drag NestJS
 * into this TypeScript project, which is the coupling the two-app split exists
 * to prevent. What keeps them honest instead is
 * `__tests__/config/settingKeyDrift.test.ts`, which reads the API's own source
 * off disk — a fixture is evidence about a fixture, and only the API's source
 * is evidence about the API (#417). The unions below are written one member
 * per line, as string literals, precisely so that suite's `unionMembers`
 * extraction can read them; see this file's foot for what still needs pinning.
 *
 * ## The two halves are different KINDS of fact, and stay apart here too
 *
 * `QuotaSummary` is a gauge: where the fleet stands now. `RateLimitEpisode`
 * and `ExhaustedWindow` are history: what happened and what Opifex did about
 * it. The API serves them from three routes rather than one payload, and the
 * screen reads all three — folding them into one type here would put back
 * exactly the confusion the endpoints were split to avoid.
 *
 * ## Nothing here is optional, and several things are nullable
 *
 * Null appears in this file wherever the API decided it could not honestly
 * answer: `burnFraction` (no vendor publishes a window capacity),
 * `position` (unknown, which is NOT healthy), `blockedUntil` (the runner could
 * not date its block), `window` (no stored window carries that reset instant),
 * `durationMs` (the episode is still open). Each one renders as an admission,
 * never as a zero — see `components/quota/quotaFormat.ts`.
 */

import type { RunStatus } from './cockpit';

// ---------------------------------------------------------------------------
// The live gauge (#231)
// ---------------------------------------------------------------------------

/**
 * How the vendor described its own position. An ORDINAL, not a percentage.
 *
 * `quotaPressureSchema` in the API. `warning` is the one worth building on: it
 * is the vendor saying "approaching the limit" while still serving requests,
 * and it is the only signal in the system that arrives BEFORE a run is parked.
 */
export type QuotaPressure = 'unknown' | 'allowed' | 'warning' | 'exhausted';

/**
 * Every pressure, worst LAST — the same order `QUOTA_PRESSURE_ORDER` uses in
 * the API, where `matchWindow` ranks windows off it.
 *
 * A value, not just a type, so a test can be exhaustive over the union: a
 * `Record<QuotaPressure, …>` catches a MISSING key at compile time, but only
 * iterating a runtime list catches a key that exists and is wrong.
 */
export const QUOTA_PRESSURES: readonly QuotaPressure[] = [
  'unknown',
  'allowed',
  'warning',
  'exhausted',
];

/** What Opifex ITSELF put through a window. Never the window's total. */
export interface OpifexConsumption {
  runs: number;
  /** How many reported no cost. The honesty half of `reportedUsd`. */
  runsWithoutCost: number;
  /** Null, never 0, when no event in the span reported a cost. */
  reportedUsd: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
}

/**
 * The single binding answer to "can this runner work right now".
 *
 * Produced by the same `meterQuotaPosition` dispatch routes on, so the screen
 * and the fleet answer the question identically rather than coincidentally.
 */
export interface QuotaPosition {
  /** True only when an observed, dated block is still in force. */
  exhausted: boolean;
  /** When it lifts — the LATEST reset among the exhausted windows. */
  resumesAt: string | null;
  /** The observation this was derived from, in words. Rendered verbatim. */
  basis: string;
}

export interface QuotaWindowReading {
  /** The vendor's own label, verbatim: `five_hour`, `weekly`, `unknown`. */
  windowKind: string;
  resetsAt: string;
  startedAt: string;
  /** On whose authority that start is claimed. */
  startedAtBasis: 'vendor-window-length' | 'first-observation';
  /** True when consumption below is a FLOOR rather than the window's whole. */
  partialWindow: boolean;
  pressure: QuotaPressure;
  /** The worst reading seen in this window. The retrospective one. */
  peakPressure: QuotaPressure;
  lastObservedAt: string;
  /** How many lines carried this window. Not a consumption measure. */
  observations: number;
  opifexConsumption: OpifexConsumption;
  /** Always null. VISION §10's metric 6 has no denominator anyone can publish. */
  burnFraction: null;
  /** One paragraph naming what the numbers are and are not. Rendered verbatim. */
  basis: string;
}

export interface QuotaRunnerReading {
  runnerKey: string;
  /** Null is UNKNOWN, not healthy. */
  position: QuotaPosition | null;
  /** EVERY window that has not yet rolled, soonest reset first. */
  windows: QuotaWindowReading[];
}

export interface QuotaSummary {
  generatedAt: string;
  /** One entry per runner with a live window. EMPTY is a real answer. */
  runners: QuotaRunnerReading[];
}

// ---------------------------------------------------------------------------
// The memory (#476)
// ---------------------------------------------------------------------------

/**
 * `RATE_LIMIT_REASONS` in `apps/api/src/quota/quota-history.ts`.
 *
 * Never flattened into one "rate limited", here or on the screen: `rate-limit`
 * is the vendor refusing an overage while the window is still live, and
 * `quota-exhausted` is the window itself spent. The first usually clears in
 * minutes; the second waits for `resetsAt`. An operator reviewing a lost
 * afternoon is asking which one it was.
 */
export type RateLimitReason = 'rate-limit' | 'quota-exhausted';

/** Both reasons, in the API's own declaration order. */
export const RATE_LIMIT_REASONS: readonly RateLimitReason[] = [
  'rate-limit',
  'quota-exhausted',
];

/**
 * `EPISODE_DISPOSITIONS` in `apps/api/src/quota/quota-history.ts` — what
 * Opifex did about a block, as far as stored state can say.
 *
 * `unknown` is a REAL answer, not an error state and not a gap. The API
 * returns it in preference to a guess, on the principle this codebase applies
 * to `Run.costUsd` and `QuotaWindow.pressure` alike: unknown is not zero, and
 * a confident wrong value is worse than an admitted absent one. It renders as
 * an admission with the observation behind it, never as an empty cell.
 */
export type EpisodeDisposition =
  | 'parked'
  | 'awaiting-park'
  | 'escalated'
  | 'resumed'
  | 'concluded'
  | 'unknown';

/** Every disposition, in the API's declaration order. */
export const EPISODE_DISPOSITIONS: readonly EpisodeDisposition[] = [
  'parked',
  'awaiting-park',
  'escalated',
  'resumed',
  'concluded',
  'unknown',
];

/**
 * The escalation raised inside an episode.
 *
 * `kind` and `status` are free strings on the wire — the API keeps them open
 * because this is a read model quoting another module's vocabulary, and a
 * closed copy would reject the first kind that module adds. Mirrored open here
 * for the same reason.
 */
export interface EpisodeEscalation {
  kind: string;
  status: string;
  raisedAt: string;
  summary: string;
}

/** The `quota_windows` row an episode blocked against. Null is expected. */
export interface EpisodeWindow {
  kind: string;
  resetsAt: string;
  /** The latest reading. May well be `allowed` again by now. */
  pressure: QuotaPressure;
  /** The worst reading ever seen in this window. The retrospective one. */
  peakPressure: QuotaPressure;
  firstObservedAt: string;
  lastObservedAt: string;
  observations: number;
}

/**
 * One rate-limit episode — `rateLimitEpisodeSchema` in the API.
 *
 * `runStatus` is the run's status NOW, which for an old episode is not its
 * state then, and is typed as the cockpit's `RunStatus` because the API's
 * `runStatusSchema` is the same closed union.
 */
export interface RateLimitEpisode {
  /** The `run_events` row id. The episode has no id of its own — no new table. */
  eventId: string;
  occurredAt: string;
  /** The vendor's own reset instant. Null when the runner could not date it. */
  blockedUntil: string | null;
  reason: RateLimitReason;

  runId: string;
  runStatus: RunStatus;
  runnerKey: string;
  /** The work-order IDENTITY, not its row id — this is shown to a human. */
  workOrderIdentity: string;
  /** `owner/name`. */
  repository: string;
  issueNumber: number;

  disposition: EpisodeDisposition;
  /** One sentence naming the observation the disposition came from. Verbatim. */
  dispositionBasis: string;

  /** The scheduled resume, for an episode the run is STILL sitting in. */
  resumesAt: string | null;
  /** When activity was next observed. An UPPER BOUND, not the resume instant. */
  nextActivityAt: string | null;
  /** `nextActivityAt - occurredAt`. Null while the episode is unbounded. */
  durationMs: number | null;

  escalation: EpisodeEscalation | null;
  window: EpisodeWindow | null;
}

/**
 * A window that ever hit the wall, and what it cost —
 * `exhaustedWindowSchema` in the API.
 *
 * Only windows whose `peakPressure` reached `exhausted` are returned; an
 * `allowed` window is not history, it is just a window.
 */
export interface ExhaustedWindow {
  runnerKey: string;
  kind: string;
  resetsAt: string;
  /** The latest reading — "it hit the wall at noon and is fine now". */
  pressure: QuotaPressure;
  /** The worst reading — why this row is here at all. */
  peakPressure: QuotaPressure;
  firstObservedAt: string;
  lastObservedAt: string;
  observations: number;
  /**
   * How many distinct runs blocked against this exact window.
   *
   * **`0` is the case the windows endpoint exists for**: the ceiling was
   * genuinely reached with nothing dispatched against it, which leaves no
   * `run_events` row and is therefore invisible to the episodes list. It is
   * data, not a gap, and the table says so in words rather than printing a
   * bare zero that reads like a missing join.
   */
  blockedRuns: number;
  /** Blocked EVENTS, which exceeds `blockedRuns` when one run blocked twice. */
  blockedEvents: number;
}
