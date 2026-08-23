import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

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
export type RunEventView = z.infer<typeof runEventSchema>;
