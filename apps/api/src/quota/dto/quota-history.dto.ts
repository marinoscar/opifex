import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { runStatusSchema } from '../../cockpit/dto/runs.dto';
import { EPISODE_DISPOSITIONS, RATE_LIMIT_REASONS } from '../quota-history';
import { quotaPressureSchema } from './quota.dto';

/**
 * Rate-limit HISTORY, as `GET /api/quota` cannot tell it (#476).
 *
 * `GET /api/quota` is a live gauge: it reads windows that have not yet rolled
 * and says where the fleet stands now. An episode an hour old is invisible to
 * it, so the operator question #476 was filed about — *"we lost an afternoon;
 * was it quota, and did the system handle it?"* — has no endpoint.
 *
 * ## No new table, and why the data is already sufficient
 *
 * #476 rules out a `rate_limit_episodes` table, and the reason is ADR-0018
 * §1: it would be a second expression of what two existing tables already own,
 * and the copy would disagree with the ledger the first time an event arrived
 * late. What exists instead:
 *
 *  - **`run_events`** carries `blockedReason` and `blockedUntil` per blocked
 *    run, joining out to the run, work order, repository and issue.
 *  - **`quota_windows`** carries one row per vendor window per runner, with
 *    `peakPressure` kept beside `pressure` for exactly this purpose — its own
 *    schema comment says `peakPressure` is *"what a human reviewing the day
 *    wants: whether this window ever hit the wall, which `pressure` forgets
 *    the moment the vendor says `allowed` again."*
 *
 * The two are complementary, not redundant, and that is the load-bearing
 * point: `quota_windows` records **the vendor's window**, `run_events` records
 * **what happened to a run inside it**. A window can reach its peak with
 * nothing dispatched against it, and a run can block against a window the
 * poller only ever sighted once. Neither subsumes the other, so keeping both
 * is one table per fact rather than two sources for one.
 *
 * ## Two endpoints, not one response with two arrays
 *
 * This file describes `GET /api/quota/events` (the run side) and
 * `GET /api/quota/windows` (the window side). They were deliberately NOT
 * folded into a single response carrying two arrays, for three reasons:
 *
 *  1. **Pagination.** The episode list is offset-paginated in this API's
 *     `flat` idiom. A sibling array in the same body either repeats in full on
 *     every page — sending the whole window list again for page 7 — or is
 *     present on page 1 only, which is a contract no generated client can
 *     model and no reader expects.
 *  2. **They have different filters and different natural orders.** Episodes
 *     order by `occurredAt` and filter by `reason`; windows order by
 *     `resetsAt` and have no reason at all. Sharing one query object would
 *     mean half of it silently applying to half of the response.
 *  3. **`@ApiDataResponse(..., { pagination: 'flat' })` describes exactly
 *     `{ items, total, page, pageSize, totalPages }`.** An undocumented extra
 *     key alongside it is precisely the "handler returns a shape the document
 *     never mentions" drift that decorator exists to remove.
 *
 * The join #476's comment asks for is still in the response, and in both
 * directions: every episode carries the `quota_windows` row it blocked against
 * (`window`, null when none is stored), and every window carries how many runs
 * blocked against it (`blockedRuns`, `0` being the "hit the wall with nothing
 * dispatched" case that criterion names).
 */

/**
 * How many episodes one page carries.
 *
 * Smaller than the events feed's ceiling because these rows are much heavier —
 * each carries a run, a work order, a repository, an escalation and a window —
 * and far rarer: blocked events are a tiny fraction of `run_events`, so a
 * hundred of them is usually most of the history there is.
 */
export const QUOTA_EVENTS_MAX_PAGE_SIZE = 100;
export const QUOTA_EVENTS_DEFAULT_PAGE_SIZE = 25;

export const QUOTA_WINDOWS_MAX_PAGE_SIZE = 100;
export const QUOTA_WINDOWS_DEFAULT_PAGE_SIZE = 25;

/**
 * `rate-limit` or `quota-exhausted`, never a flattened "rate limited".
 *
 * Derived from {@link RATE_LIMIT_REASONS} rather than restated, so the filter
 * this endpoint accepts and the set the query actually matches cannot drift
 * apart.
 */
export const rateLimitReasonSchema = z.enum(RATE_LIMIT_REASONS);

/** See {@link EPISODE_DISPOSITIONS} for what each value asserts. */
export const episodeDispositionSchema = z.enum(EPISODE_DISPOSITIONS);

export const quotaEventsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(QUOTA_EVENTS_MAX_PAGE_SIZE)
    .default(QUOTA_EVENTS_DEFAULT_PAGE_SIZE),
  /**
   * Inclusive lower bound on `occurredAt`.
   *
   * A plain comparison on the raw column, never a function of it: the partial
   * index this endpoint depends on is
   * `(occurred_at) WHERE blocked_reason IS NOT NULL`, and wrapping the column
   * in `date_trunc` or a timezone cast would make it unusable.
   */
  since: z.iso.datetime().optional(),
  /** Inclusive upper bound on `occurredAt`. */
  until: z.iso.datetime().optional(),
  /** Only blocks suffered by runs on this runner. */
  runnerKey: z.string().min(1).optional(),
  reason: rateLimitReasonSchema.optional(),
});

export class QuotaEventsQueryDto extends createZodDto(quotaEventsQuerySchema) {}

/**
 * The escalation raised inside an episode, where one was.
 *
 * `kind` and `status` are free strings rather than enums mirroring
 * `EscalationKind` / `EscalationStatus`: this is a read model quoting another
 * module's vocabulary, and a closed copy here would reject the first kind that
 * module adds. `escalations/dto/escalation.dto.ts` remains the contract for
 * escalations themselves.
 */
export const episodeEscalationSchema = z.object({
  kind: z.string(),
  status: z.string(),
  raisedAt: z.iso.datetime(),
  summary: z.string(),
});

/**
 * The `quota_windows` row an episode blocked against.
 *
 * Null is a real and expected answer, not a lookup failure — see `matchWindow`
 * in `quota-history.ts` for why an exact match on the reset instant is the
 * only honest join and why a nearest-window guess was rejected.
 */
export const episodeWindowSchema = z.object({
  /** The vendor's own label, verbatim: `five_hour`, `weekly`, `unknown`. */
  kind: z.string(),
  resetsAt: z.iso.datetime(),
  /** The latest reading. May well be `allowed` again by now. */
  pressure: quotaPressureSchema,
  /** The worst reading ever seen in this window. The retrospective one. */
  peakPressure: quotaPressureSchema,
  firstObservedAt: z.iso.datetime(),
  lastObservedAt: z.iso.datetime(),
  /** How many lines carried this window. Not a consumption measure. */
  observations: z.number().int(),
});

export const rateLimitEpisodeSchema = z.object({
  /** The `run_events` row id. The episode has no id of its own — no new table. */
  eventId: z.uuid(),
  occurredAt: z.iso.datetime(),
  /** The vendor's own reset instant. Null when the runner could not date it. */
  blockedUntil: z.iso.datetime().nullable(),
  reason: rateLimitReasonSchema,

  runId: z.uuid(),
  /** The run's status NOW, which for an old episode is not its state then. */
  runStatus: runStatusSchema,
  runnerKey: z.string(),
  /** The work-order IDENTITY, not its row id — this is shown to a human. */
  workOrderIdentity: z.string(),
  /** `owner/name`. */
  repository: z.string(),
  issueNumber: z.number().int(),

  /**
   * What Opifex did about it. The point of #476.
   *
   * `unknown` is a real answer and is preferred to a guess; see
   * {@link EPISODE_DISPOSITIONS}.
   */
  disposition: episodeDispositionSchema,
  /** One sentence naming the observation the disposition came from. */
  dispositionBasis: z.string(),

  /**
   * The scheduled resume, for an episode the run is STILL sitting in.
   *
   * Null for every historical episode even if the run has a `resumesAt` today:
   * that column describes the current block, and reading it back onto an older
   * one would attribute a park to a block that was over days ago.
   */
  resumesAt: z.iso.datetime().nullable(),

  /**
   * When activity was next observed on this run. An UPPER BOUND, not the
   * resume instant — `boundedAt` in `quota-history.ts` says what it is derived
   * from and why the exact answer is not available.
   */
  nextActivityAt: z.iso.datetime().nullable(),
  /** `nextActivityAt - occurredAt`. Null while the episode is unbounded. */
  durationMs: z.number().int().nullable(),

  escalation: episodeEscalationSchema.nullable(),
  window: episodeWindowSchema.nullable(),
});

export class RateLimitEpisodeDto extends createZodDto(rateLimitEpisodeSchema) {}

export const quotaWindowsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(QUOTA_WINDOWS_MAX_PAGE_SIZE)
    .default(QUOTA_WINDOWS_DEFAULT_PAGE_SIZE),
  /**
   * Bounds on the window's OBSERVATION SPAN, not on a single instant.
   *
   * A window is a stretch of time, and "did we hit the wall this afternoon"
   * has to match a window that was first sighted before the afternoon and last
   * sighted during it. So the filter is an overlap test —
   * `lastObservedAt >= since AND firstObservedAt <= until` — rather than a
   * comparison against `resetsAt`, which would miss every window that started
   * before the range and was still exhausted inside it.
   */
  since: z.iso.datetime().optional(),
  until: z.iso.datetime().optional(),
  runnerKey: z.string().min(1).optional(),
});

export class QuotaWindowsQueryDto extends createZodDto(
  quotaWindowsQuerySchema,
) {}

/**
 * A window that ever hit the wall, and what it cost.
 *
 * Only windows whose `peakPressure` reached `exhausted` are returned, and that
 * is the endpoint's whole selectivity: an `allowed` window is not history, it
 * is just a window. `pressure` is carried beside `peakPressure` anyway,
 * because "it hit the wall at noon and is fine now" and "it is still at the
 * wall" are different things to be told.
 */
export const exhaustedWindowSchema = z.object({
  runnerKey: z.string(),
  kind: z.string(),
  resetsAt: z.iso.datetime(),
  pressure: quotaPressureSchema,
  peakPressure: quotaPressureSchema,
  firstObservedAt: z.iso.datetime(),
  lastObservedAt: z.iso.datetime(),
  observations: z.number().int(),

  /**
   * How many distinct runs blocked against this exact window.
   *
   * **`0` is the case this endpoint exists for.** A window that reached
   * `exhausted` with nothing dispatched against it leaves no `run_events` row
   * at all, so it is invisible to `GET /api/quota/events` — and it is still a
   * real answer to "when did we hit rate limits", because the ceiling was
   * genuinely reached. #476's added acceptance criterion is precisely that a
   * window which blocked runs stays distinguishable from one that did not.
   *
   * Counted by the same exact-instant join `matchWindow` uses: blocked events
   * on this runner whose `blockedUntil` equals this window's `resetsAt`.
   */
  blockedRuns: z.number().int(),
  /** Blocked EVENTS, which exceeds `blockedRuns` when one run blocked twice. */
  blockedEvents: z.number().int(),
});

export class ExhaustedWindowDto extends createZodDto(exhaustedWindowSchema) {}

export type RateLimitEpisodeView = z.infer<typeof rateLimitEpisodeSchema>;
export type ExhaustedWindowView = z.infer<typeof exhaustedWindowSchema>;
