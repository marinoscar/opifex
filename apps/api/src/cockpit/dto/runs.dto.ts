import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { CHECK_STATUSES, WATCHDOG_CHECKS } from '../../watchdog/check-coverage';
import { workOrderRefSchema } from './queue.dto';

/**
 * Runs, as the cockpit reads them.
 *
 * Every field exists because `apps/web/src/types/cockpit.ts` renders it. That
 * file is explicit that its shapes were a PROPOSAL written before any endpoint
 * existed and must be reconciled against the real response in the same pull
 * request — this schema is that reconciliation for the runs family.
 */

export const RUNS_MAX_PAGE_SIZE = 100;
export const RUNS_DEFAULT_PAGE_SIZE = 25;

/** Events per page on a run's timeline. */
export const EVENTS_MAX_PAGE_SIZE = 200;
export const EVENTS_DEFAULT_PAGE_SIZE = 50;

/**
 * The lifecycle state of a run, as the operator reads it.
 *
 * Deliberately NOT a mirror of the six normalized event types: events are what
 * the runner REPORTS, a status is what the control plane CONCLUDED. `stalled`
 * and `quarantined` have no corresponding event at all — they are watchdog and
 * policy verdicts, which is exactly why the two vocabularies must not collapse.
 */
export const runStatusSchema = z.enum([
  'running',
  'succeeded',
  'stalled',
  'blocked',
  'failed',
  'quarantined',
]);

export const runsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(RUNS_MAX_PAGE_SIZE)
    .default(RUNS_DEFAULT_PAGE_SIZE),
  /**
   * Only runs a human has to do something about.
   *
   * A SERVER-side filter, and that is load-bearing: the verdict about whether
   * a run needs a human is the control plane's (VISION §9's watchdog and #57's
   * escalation lifecycle). A UI filtering by status locally would be
   * re-implementing the watchdog in the browser, out of date by one poll
   * interval and wrong the moment the rules change.
   */
  needsAttention: z.stringbool().optional(),
  status: runStatusSchema.optional(),
  /**
   * Which column to order by, and which way (#82).
   *
   * A closed enum rather than a free column name: an ordering built from an
   * arbitrary string is one query parameter away from ordering by a column
   * that is not indexed, and the table it scans is the highest-volume one in
   * the schema.
   *
   * `lastEventAt` is here because #82 calls it "the operationally important
   * one" — it is the quantity the watchdog judges on, and being able to sort
   * by it is how an operator sanity-checks that detection works at all.
   */
  sort: z.enum(['startedAt', 'lastEventAt', 'costUsd', 'status']).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
});

export class RunsQueryDto extends createZodDto(runsQuerySchema) {}

export const runEventsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(EVENTS_MAX_PAGE_SIZE)
    .default(EVENTS_DEFAULT_PAGE_SIZE),
});

export class RunEventsQueryDto extends createZodDto(runEventsQuerySchema) {}

/**
 * A run, as a list row or an attention row renders it.
 *
 * `attentionReason` and `resumesAt` are separate on purpose, and this is the
 * one shape decision in the file that must not be collapsed. VISION §9 gives
 * three failure modes three different responses, and the operator's next move
 * is decided by which of these is populated:
 *
 *  - `attentionReason` set → a human has to do something
 *  - `resumesAt` set       → the system will handle it; acting is wasted effort
 *
 * A single "message" field would destroy exactly that distinction, which the
 * cockpit's own types call the most expensive mistake this UI can make.
 */
export const runSummarySchema = z.object({
  id: z.uuid(),
  workOrder: workOrderRefSchema,
  status: runStatusSchema,
  startedAt: z.iso.datetime(),
  /**
   * Null when nothing has ever been reported.
   *
   * Detection latency (success metric #1) is measured from this, so it is the
   * age the attention panel shows — NOT `startedAt`. A run that has been
   * running happily for six hours is not the problem; one silent for six
   * minutes is.
   */
  lastEventAt: z.iso.datetime().nullable(),
  attentionReason: z.string().nullable(),
  resumesAt: z.iso.datetime().nullable(),
  /** Which runner executed it. VISION §6 keeps this vendor-neutral. */
  runner: z.string(),
  costUsd: z.number().nullable(),
  pullRequestUrl: z.string().nullable(),
});

export class RunSummaryDto extends createZodDto(runSummarySchema) {}

/**
 * One watchdog check, and what it is worth on this run (#104).
 *
 * The enums are restated from `watchdog/check-coverage.ts` rather than copied:
 * a status the API could emit but the schema does not name would be stripped
 * by the response pipe, and the value most likely to be added later is a
 * WORSE one than `unavailable` — silently dropping that is the failure this
 * whole family of shapes exists to prevent.
 */
export const checkCoverageSchema = z.object({
  check: z.enum(WATCHDOG_CHECKS),
  /**
   * `unavailable` is not a failed check. It means the check could not run at
   * all, so the failure mode it guards is UNGUARDED on this run — which is a
   * different thing from a check that ran and found nothing, and the cockpit
   * must never render them the same way.
   */
  status: z.enum(CHECK_STATUSES),
  /** WHAT is being watched. Degrades independently of `status`. */
  signal: z.string(),
  /** Why, naming the declared capability responsible. Never empty. */
  reason: z.string(),
  /** The silence threshold in force; null on checks that have none. */
  thresholdMs: z.number().nullable(),
});

export class CheckCoverageDto extends createZodDto(checkCoverageSchema) {}

/**
 * Which checks are protecting one run, derived from what its runner declared.
 *
 * VISION §6: *"equal observability across vendors is not achievable. A common
 * floor that some runners exceed is."* This is the floor made visible per run
 * — an operator seeing "loop detection: unavailable on this runner"
 * understands the risk they are carrying, and one seeing nothing assumes there
 * is none.
 */
export const runCheckCoverageSchema = z.object({
  runnerKey: z.string(),
  /** Null when the runner has filed no capability manifest at all. */
  streamingFidelity: z.enum(['full', 'partial', 'none']).nullable(),
  rateLimitSignal: z.enum(['structured', 'heuristic', 'none']).nullable(),
  /**
   * The worst status among the checks, for a badge that does not want to
   * re-derive one. `unavailable` dominates: three healthy checks do not
   * average away a fourth that cannot run.
   */
  weakest: z.enum(CHECK_STATUSES),
  /** Always all four, always in the same order. */
  checks: z.array(checkCoverageSchema),
});

export class RunCheckCoverageDto extends createZodDto(runCheckCoverageSchema) {}

/**
 * One run, as `GET /runs/:id` returns it.
 *
 * A superset of the list row rather than a widening of it. `checkCoverage`
 * costs a join through the runner's capability manifest and is per-run detail
 * an operator reads one run at a time — putting it on every row of an already
 * wide list would pay for it on the screen that cannot use it. The list stays
 * `RunSummary`; only the detail carries this.
 */
export const runDetailSchema = runSummarySchema.extend({
  checkCoverage: runCheckCoverageSchema,
});

export class RunDetailDto extends createZodDto(runDetailSchema) {}

/**
 * The six normalized event types. Every runner maps into these.
 */
export const runEventTypeSchema = z.enum([
  'run.started',
  'run.heartbeat',
  'run.progress',
  'run.blocked',
  'run.completed',
  'run.failed',
]);

/**
 * Where an event came from.
 *
 * VISION §9 is emphatic: *a synthesized event must never masquerade as a
 * report.* Carried as a first-class field rather than folded into the summary
 * text, because two independent liveness sources only buy anything if the
 * operator can tell which one spoke.
 */
export const runEventSourceSchema = z.enum(['runner', 'git', 'control-plane']);

export const runEventSchema = z.object({
  id: z.uuid(),
  type: runEventTypeSchema,
  source: runEventSourceSchema,
  occurredAt: z.iso.datetime(),
  runId: z.uuid(),
  /** The work-order IDENTITY, not its row id — this is shown to a human. */
  workOrderId: z.string(),
  /** One line, already rendered for humans by the API. */
  summary: z.string(),
});

export class RunEventDto extends createZodDto(runEventSchema) {}

export type RunSummary = z.infer<typeof runSummarySchema>;
export type RunDetail = z.infer<typeof runDetailSchema>;
export type RunEventView = z.infer<typeof runEventSchema>;
