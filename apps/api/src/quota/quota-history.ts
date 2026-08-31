import type { RunStatus } from '@prisma/client';

import type { BlockedReason } from '../run-events/run-event.types';
import {
  QUOTA_PRESSURE_ORDER,
  type QuotaPressure,
} from '../runners/runner.types';

/**
 * Rate-limit history: what a stored block actually tells you happened (#476).
 *
 * ## Why this file is pure, and separate from the service
 *
 * Everything below is a function of rows that have already been read. The
 * service does the I/O; this decides what the rows MEAN. That split is the
 * same one `watchdog/blocked-parking.ts` makes for the write side, and for the
 * same reason: the interesting part of #476 is not the query, it is the claim
 * the response makes about what Opifex did — and a claim nobody can test
 * without a live database is a claim nobody tests.
 *
 * ## The one rule everything here obeys
 *
 * **Never assert more than the stored rows support.** #476 asks for a
 * disposition — "what Opifex did about it" — and the honest answer for some
 * episodes is that nothing recorded says. Those get {@link
 * EPISODE_DISPOSITIONS}' `unknown`, with a `basis` sentence naming what was
 * looked at, rather than a plausible-sounding `parked` inferred from a run
 * that merely happens to have stopped. An operator who cannot trust one row
 * cannot trust the column.
 */

/**
 * The two block reasons that are facts about the SUBSCRIPTION, kept distinct.
 *
 * #476 is explicit that these must not be flattened into one "rate limited":
 * `rate-limit` is the vendor refusing an overage while the window is still
 * live, `quota-exhausted` is the window itself spent. Those are different
 * operational facts — the first often clears in minutes, the second waits for
 * `resetsAt` — and an operator reviewing a lost afternoon is asking which one
 * it was.
 *
 * The other three `BlockedReason` values (`awaiting-approval`,
 * `upstream-unavailable`, `unknown`) are deliberately NOT history here: the
 * first two are facts about one run and imply nothing about the
 * subscription, and `unknown` is a block nobody could classify, which VISION
 * §6's "unknown is not zero" says must not be filed under quota.
 *
 * This list is the same pair `QUOTA_BLOCK_REASONS` in
 * `dispatch/dispatch.service.ts` routes on, and the two must agree. It is
 * restated rather than imported because `dispatch.service.ts` imports
 * `quota/quota-window.ts` as a VALUE, so importing it back here would close an
 * ES module cycle — `QuotaModule`'s own doc comment makes the same point about
 * the Nest dependency running one way only. The `satisfies` below at least
 * makes a value that is not a `BlockedReason` at all a compile error.
 */
export const RATE_LIMIT_REASONS = [
  'rate-limit',
  'quota-exhausted',
] as const satisfies readonly BlockedReason[];

export type RateLimitReason = (typeof RATE_LIMIT_REASONS)[number];

/**
 * What Opifex did about a block, as far as stored state can say.
 *
 * ## Read `unknown` as a real answer, not a gap
 *
 * #476's whole point is that "a limit was hit" is half an answer. The other
 * half has to come from somewhere observable, and the observable things are:
 * the run's current status, whether a resume was scheduled (`Run.resumesAt`),
 * whether a later event proves the run reported again, and whether an
 * escalation was raised inside the episode. When none of those says anything,
 * `unknown` is what is true. It is preferred over a guess on the principle
 * this codebase applies to `Run.costUsd` and `QuotaWindow.pressure` alike:
 * unknown is not zero, and a confident wrong value is worse than an admitted
 * absent one.
 *
 * ## `parked`, `awaiting-park` and `escalated` describe the CURRENT block only
 *
 * `Run.status`, `Run.resumesAt` and the escalation lifecycle are live state.
 * They describe the block the run is sitting in right now, not one it sat in
 * last Tuesday. So those three verdicts are only ever reached for the LATEST
 * block on a run (`nextBlockAt === null`); an earlier block on the same run is
 * judged by what demonstrably followed it instead. Reading today's
 * `resumesAt` back onto a week-old episode would attribute a park to a block
 * that had already been over for days.
 *
 * ## Ordering note (#475)
 *
 * `parked` and `awaiting-park` both require `Run.status === 'blocked'`. On
 * `main` today **nothing writes that status** — that is the bug #475 fixes —
 * so until it merges this derivation reaches `resumed`, `concluded` or
 * `unknown` and never the two park verdicts. That is not a defect here and
 * must not be "fixed" by inferring a park from something else: the derivation
 * is written for the world #475 restores, and depends only on the status
 * becoming reachable, not on any code #475 adds.
 */
export const EPISODE_DISPOSITIONS = [
  /** Still blocked, with a resume scheduled. The system is handling it. */
  'parked',
  /**
   * Still blocked, with NO resume scheduled.
   *
   * Either the watchdog has not ticked since the block, or the block carried
   * no reset time and is still inside `UNDATED_BLOCK_PATIENCE_MS`
   * (`watchdog/blocked-parking.ts`). Distinct from `parked` because "we have
   * seen it and scheduled nothing yet" and "we have scheduled a resume" are
   * the two states an operator most needs to tell apart while it is happening.
   */
  'awaiting-park',
  /** A human was told inside this episode. See {@link episodeEscalation}. */
  'escalated',
  /** The run reported activity after the block, and has not concluded. */
  'resumed',
  /** The run reached a terminal state after the block. */
  'concluded',
  /** Nothing stored says. See this constant's doc comment. */
  'unknown',
] as const;

export type EpisodeDisposition = (typeof EPISODE_DISPOSITIONS)[number];

/**
 * Run statuses that end the story.
 *
 * `stalled` is absent on purpose: the watchdog sweeps `running` AND `stalled`
 * runs, so a stalled run is still being worked on by the control plane. Only
 * these three mean nothing further will happen without a human or a new run.
 */
const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'quarantined',
];

/**
 * The escalation kind a block episode can raise.
 *
 * `actionsForParking` in `watchdog/blocked-parking.ts` raises `system` — not
 * `run_stalled` — for an undated block, with the reasoning that the run is not
 * stalled, it is correctly blocked, and what has failed is that nothing can
 * date it. Matching on that one kind is therefore matching on the escalation
 * the parking path itself emits.
 *
 * A `budget_exceeded` or `run_stalled` escalation raised while a run happened
 * to be parked is NOT attributed to the quota episode. It is a real event, but
 * it is not what Opifex did about the rate limit, and folding it in would make
 * the disposition column say "escalated" for episodes nobody was ever told
 * about on quota grounds.
 */
const BLOCK_ESCALATION_KIND = 'system';

/** An escalation row, as this file needs it. */
export interface EpisodeEscalation {
  kind: string;
  status: string;
  raisedAt: Date;
  summary: string;
}

/**
 * The `quota_windows` row a block names, if one is stored.
 *
 * See {@link matchWindow} for how "the row it names" is decided, and why the
 * match is exact.
 */
export interface EpisodeWindow {
  kind: string;
  resetsAt: Date;
  pressure: QuotaPressure;
  peakPressure: QuotaPressure;
  firstObservedAt: Date;
  lastObservedAt: Date;
  observations: number;
}

/**
 * Everything the service loaded about one blocked event, before interpretation.
 *
 * Deliberately flat and made of primitives: this is the seam a unit test
 * writes against, and a shape carrying Prisma model types would drag the
 * generated client into every assertion.
 */
export interface EpisodeFacts {
  eventId: string;
  occurredAt: Date;
  /** The vendor's own reset instant, where it supplied one. */
  blockedUntil: Date | null;
  reason: RateLimitReason;

  runId: string;
  runnerKey: string;
  runStatus: RunStatus;
  /** The resume the watchdog scheduled: reset time plus jitter (#56). */
  runResumesAt: Date | null;
  runEndedAt: Date | null;
  /**
   * `Run.lastEventAt`, denormalized.
   *
   * Used as the activity bound for the latest block on a run — see
   * {@link boundedAt} for why this rather than a per-episode "next event"
   * lookup.
   */
  runLastEventAt: Date | null;

  workOrderIdentity: string;
  /** `owner/name`, already joined. */
  repository: string;
  issueNumber: number;

  /**
   * When the SAME run next blocked, or null when this is its latest block.
   *
   * Doing double duty on purpose: it is both the tightest available bound on
   * this episode (a run cannot block again without having run again) and the
   * flag that says whether live run state may be read onto this episode at all.
   */
  nextBlockAt: Date | null;

  /** Every escalation on this run. Filtered to the episode here, not in SQL. */
  escalations: readonly EpisodeEscalation[];

  /** The window this block names, or null when none is stored. */
  window: EpisodeWindow | null;
}

/** One rate-limit episode, as the API returns it. */
export interface RateLimitEpisode {
  eventId: string;
  occurredAt: string;
  blockedUntil: string | null;
  reason: RateLimitReason;
  runId: string;
  runStatus: RunStatus;
  runnerKey: string;
  workOrderIdentity: string;
  repository: string;
  issueNumber: number;
  disposition: EpisodeDisposition;
  dispositionBasis: string;
  resumesAt: string | null;
  nextActivityAt: string | null;
  durationMs: number | null;
  escalation: {
    kind: string;
    status: string;
    raisedAt: string;
    summary: string;
  } | null;
  window: {
    kind: string;
    resetsAt: string;
    pressure: QuotaPressure;
    peakPressure: QuotaPressure;
    firstObservedAt: string;
    lastObservedAt: string;
    observations: number;
  } | null;
}

/**
 * When the episode stopped being open, as far as anything observed.
 *
 * ## Two bounds, and why neither is "the next run event"
 *
 * The obvious implementation is "the first `run_events` row on this run after
 * `occurredAt`". It is rejected for cost: `run_events` is named in its own
 * schema comment as the high-volume table — every tool call of every run lands
 * a row — and asking that question per episode is an N+1 over exactly the
 * table this endpoint is trying to read cheaply. Postgres would answer it well
 * with a lateral join; there is no raw SQL anywhere in this API, and
 * introducing the first instance of it for a bound this approximate is not a
 * trade worth making.
 *
 * So two bounds that are already loaded:
 *
 *  - **An earlier block** is bounded by the run's NEXT block. A run cannot
 *    report a second block without having been invoked and run again, so the
 *    later block proves activity resumed at or before that instant. It is an
 *    upper bound on the resumption, not the resumption itself, and the
 *    response's field is named `nextActivityAt` rather than `resumedAt` to say
 *    so.
 *  - **The latest block** is bounded by `Run.lastEventAt`, which is
 *    denormalized onto the run precisely so age questions are a column read
 *    rather than an aggregate (see its schema comment). Strictly greater than
 *    `occurredAt`, because when the block IS the last event the two are equal
 *    and nothing has followed.
 *
 * `RunAttempt` would be the exact answer — each resume is a fresh attempt by
 * the model's own doc comment — and is not used because **nothing writes
 * `RunAttempt` rows anywhere in this API today**. A join onto a table that is
 * always empty would report "never resumed" for every episode in the system.
 */
export function boundedAt(facts: EpisodeFacts): Date | null {
  if (facts.nextBlockAt) return facts.nextBlockAt;
  if (facts.runLastEventAt && facts.runLastEventAt > facts.occurredAt) {
    return facts.runLastEventAt;
  }
  return null;
}

/**
 * The escalation raised INSIDE this episode, if any.
 *
 * Bounded on both sides. The lower bound is the block itself: an escalation
 * raised before it belongs to whatever came before. The upper bound is
 * {@link boundedAt}, so an escalation raised long after the run had resumed is
 * not credited to a quota block it had nothing to do with. When the episode is
 * unbounded — the run is still sitting in it — everything after the block
 * counts, which is correct: there is nothing after it yet except this.
 *
 * Earliest first, because the first time a human was told is when Opifex gave
 * up handling it alone.
 */
export function episodeEscalation(
  facts: EpisodeFacts,
): EpisodeEscalation | null {
  const until = boundedAt(facts);

  const inside = facts.escalations
    .filter(
      (escalation) =>
        escalation.kind === BLOCK_ESCALATION_KIND &&
        escalation.raisedAt >= facts.occurredAt &&
        (until === null || escalation.raisedAt <= until),
    )
    .sort((a, b) => a.raisedAt.getTime() - b.raisedAt.getTime());

  return inside[0] ?? null;
}

/**
 * What Opifex did, and the one sentence saying how that was concluded.
 *
 * The precedence is the design, so it is spelled out rather than left to the
 * order of the `if`s below:
 *
 *  1. **`escalated` wins over everything.** If a human was told, that is what
 *     happened, regardless of what else was also true — a run can be parked
 *     AND have had its undated block escalated, and "we asked for help" is the
 *     louder of the two facts.
 *  2. **Live park state, but only for the latest block** (see
 *     {@link EPISODE_DISPOSITIONS}). `resumesAt` set means `parked`; blocked
 *     with nothing scheduled means `awaiting-park`.
 *  3. **Observed activity** — the run reported again, so it `resumed`, unless
 *     the run has since concluded, in which case `concluded` is the end of the
 *     story. Note the asymmetry: a NON-latest block on a run that later
 *     succeeded reads `resumed`, because that block's own outcome was a
 *     resumption; the conclusion belongs to the last episode, not this one.
 *  4. **A terminal run with nothing after the block** still `concluded` — the
 *     run stopped, even though no event marked it (policy can fail or
 *     quarantine a run without a runner reporting anything).
 *  5. Otherwise `unknown`.
 *
 * `basis` names the observation each verdict came from, in the same spirit as
 * `quotaPositionSchema.basis`: a one-word column that cannot be audited is a
 * column that gets argued with.
 */
export function deriveDisposition(facts: EpisodeFacts): {
  disposition: EpisodeDisposition;
  basis: string;
  escalation: EpisodeEscalation | null;
} {
  const escalation = episodeEscalation(facts);
  const isLatestBlock = facts.nextBlockAt === null;
  const bound = boundedAt(facts);
  const terminal =
    facts.runEndedAt !== null ||
    TERMINAL_RUN_STATUSES.includes(facts.runStatus);

  if (escalation) {
    return {
      disposition: 'escalated',
      basis:
        `a '${escalation.kind}' escalation was raised at ` +
        `${escalation.raisedAt.toISOString()}, inside this episode, and is ` +
        `'${escalation.status}'`,
      escalation,
    };
  }

  if (isLatestBlock && facts.runStatus === 'blocked') {
    if (facts.runResumesAt) {
      return {
        disposition: 'parked',
        basis:
          `the run is still blocked and a resume is scheduled for ` +
          `${facts.runResumesAt.toISOString()} (the reset time plus jitter)`,
        escalation,
      };
    }
    return {
      disposition: 'awaiting-park',
      basis:
        'the run is blocked and no resume has been scheduled yet — either the ' +
        'watchdog has not ticked since, or the block carried no reset time and ' +
        'is still inside its patience window',
      escalation,
    };
  }

  if (bound) {
    if (isLatestBlock && terminal) {
      return {
        disposition: 'concluded',
        basis:
          `the run reported again at ${bound.toISOString()} and has since ` +
          `concluded as '${facts.runStatus}'`,
        escalation,
      };
    }
    return {
      disposition: 'resumed',
      basis: facts.nextBlockAt
        ? `the run blocked again at ${bound.toISOString()}, which it could not ` +
          'have done without running again in between'
        : `the run reported again at ${bound.toISOString()}`,
      escalation,
    };
  }

  if (isLatestBlock && terminal) {
    return {
      disposition: 'concluded',
      basis:
        `the run concluded as '${facts.runStatus}' with no event reported ` +
        'after the block — policy ended it rather than a runner',
      escalation,
    };
  }

  return {
    disposition: 'unknown',
    basis:
      `nothing stored says: the run is '${facts.runStatus}', no resume is ` +
      'scheduled, no later activity was observed and no escalation was raised ' +
      'inside the episode',
    escalation,
  };
}

/** Interpret one loaded block into the episode the API returns. */
export function toEpisode(facts: EpisodeFacts): RateLimitEpisode {
  const { disposition, basis, escalation } = deriveDisposition(facts);
  const bound = boundedAt(facts);

  return {
    eventId: facts.eventId,
    occurredAt: facts.occurredAt.toISOString(),
    blockedUntil: facts.blockedUntil?.toISOString() ?? null,
    reason: facts.reason,
    runId: facts.runId,
    runStatus: facts.runStatus,
    runnerKey: facts.runnerKey,
    workOrderIdentity: facts.workOrderIdentity,
    repository: facts.repository,
    issueNumber: facts.issueNumber,
    disposition,
    dispositionBasis: basis,
    // Only ever the LIVE schedule, and only where it describes THIS block —
    // see EPISODE_DISPOSITIONS on why today's `resumesAt` must not be read
    // back onto a week-old episode.
    resumesAt:
      facts.nextBlockAt === null && facts.runStatus === 'blocked'
        ? (facts.runResumesAt?.toISOString() ?? null)
        : null,
    nextActivityAt: bound?.toISOString() ?? null,
    durationMs: bound ? bound.getTime() - facts.occurredAt.getTime() : null,
    escalation: escalation
      ? {
          kind: escalation.kind,
          status: escalation.status,
          raisedAt: escalation.raisedAt.toISOString(),
          summary: escalation.summary,
        }
      : null,
    window: facts.window
      ? {
          kind: facts.window.kind,
          resetsAt: facts.window.resetsAt.toISOString(),
          pressure: facts.window.pressure,
          peakPressure: facts.window.peakPressure,
          firstObservedAt: facts.window.firstObservedAt.toISOString(),
          lastObservedAt: facts.window.lastObservedAt.toISOString(),
          observations: facts.window.observations,
        }
      : null,
  };
}

/**
 * The stored window a block names, matched EXACTLY on runner and reset instant.
 *
 * `QuotaWindow`'s identity is `(runnerKey, kind, resetsAt)` and a blocked
 * event's `blockedUntil` is the same vendor-reported reset instant, so an
 * equality match is the join — no heuristic required when both halves were
 * observed.
 *
 * A NEAREST-window fallback was considered and rejected. `QuotaWindow`'s own
 * schema comment notes that the vendor's reported reset drifts, producing two
 * rows of a kind; picking the closest one would therefore silently attribute
 * an episode to a window it did not name, and the response would present a
 * guess with the same confidence as a fact. `null` — "no stored window carries
 * that reset instant" — is the honest answer, and it is a real and expected
 * case: a run can block against a window the poller never happened to sight
 * (#231's poller and the runner's block report are independent observations).
 *
 * When more than one kind shares the instant, the worse peak wins: that is the
 * window that explains the block. Ties fall to the earlier first sighting, so
 * the result is stable rather than dependent on row order.
 */
export function matchWindow(
  runnerKey: string,
  blockedUntil: Date | null,
  windows: readonly (EpisodeWindow & { runnerKey: string })[],
): EpisodeWindow | null {
  if (!blockedUntil) return null;

  const candidates = windows.filter(
    (window) =>
      window.runnerKey === runnerKey &&
      window.resetsAt.getTime() === blockedUntil.getTime(),
  );
  if (candidates.length === 0) return null;

  return [...candidates].sort(
    (a, b) =>
      // `QUOTA_PRESSURE_ORDER` is worst-LAST, so the descending subtraction
      // puts the worse peak first. Reused rather than restated: `worsePressure`
      // in `quota-window.ts` ranks the write path off this same array, and two
      // orderings of one ordinal is the drift this endpoint would notice last.
      QUOTA_PRESSURE_ORDER.indexOf(b.peakPressure) -
        QUOTA_PRESSURE_ORDER.indexOf(a.peakPressure) ||
      a.firstObservedAt.getTime() - b.firstObservedAt.getTime(),
  )[0]!;
}
