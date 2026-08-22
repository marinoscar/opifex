import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const listEscalationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z
    .enum(['raised', 'dispatched', 'delivered', 'failed', 'acknowledged', 'resolved'])
    .optional(),
  /**
   * Only escalations nobody has dealt with.
   *
   * The triage view. A delivered-but-unacknowledged escalation still counts:
   * the operator was told and has not acted.
   */
  unresolvedOnly: z.stringbool().optional(),
  /**
   * One run's escalations.
   *
   * The per-run half of #59's queryability requirement: the aggregate says
   * the fleet is slow, this says which run it was.
   */
  runId: z.uuid().optional(),
});

export class ListEscalationsQueryDto extends createZodDto(listEscalationsQuerySchema) {}

export const escalationResponseSchema = z.object({
  id: z.uuid(),
  runId: z.uuid().nullable(),
  kind: z.string(),
  status: z.string(),
  summary: z.string(),
  detail: z.string().nullable(),
  transport: z.string().nullable(),
  deliveryAttempts: z.number().int(),
  failureReason: z.string().nullable(),
  /** When the run stopped making progress. Null when nothing could measure it. */
  progressStoppedAt: z.iso.datetime().nullable(),
  /** Which liveness source last saw the run alive. */
  detectionSource: z.enum(['runner', 'git', 'control_plane']).nullable(),
  /** Stop to noticed, milliseconds. */
  detectLatencyMs: z.number().int().nullable(),
  /** Stop to a human being informed, milliseconds. VISION §10's metric. */
  notifyLatencyMs: z.number().int().nullable(),
  raisedAt: z.iso.datetime(),
  dispatchedAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  acknowledgedAt: z.iso.datetime().nullable(),
  acknowledgedById: z.uuid().nullable(),
});

export class EscalationResponseDto extends createZodDto(escalationResponseSchema) {}

export const latencySummaryQuerySchema = z.object({
  /** Inclusive lower bound on `raisedAt`. Defaults to the whole history. */
  since: z.iso.datetime().optional(),
  /** Inclusive upper bound on `raisedAt`. */
  until: z.iso.datetime().optional(),
  /** `owner/name`. */
  repository: z.string().optional(),
});

export class LatencySummaryQueryDto extends createZodDto(latencySummaryQuerySchema) {}

const latencyStatsSchema = z.object({
  count: z.number().int(),
  p50Ms: z.number().int().nullable(),
  p90Ms: z.number().int().nullable(),
  p99Ms: z.number().int().nullable(),
  maxMs: z.number().int().nullable(),
});

const latencyGroupSchema = z.object({
  /** Stop to a human being informed. THE metric. */
  notified: latencyStatsSchema,
  /** Stop to Opifex noticing. Reported so the gap against `notified` shows. */
  detected: latencyStatsSchema,
  /**
   * Measurable, raised, and never delivered — an unbounded stop-to-notified
   * latency. Reported next to the percentiles it is missing from, because a
   * broken transport otherwise renders as excellent latency over a tiny
   * sample.
   */
  awaitingNotification: z.number().int(),
  /** Raised with no stop time at all, such as a `system` escalation. */
  unmeasurable: z.number().int(),
});

export const latencySummaryResponseSchema = latencyGroupSchema.extend({
  since: z.iso.datetime().nullable(),
  until: z.iso.datetime().nullable(),
  /** True when the window held more escalations than one summary reads. */
  truncated: z.boolean(),
  sampleSize: z.number().int(),
  /**
   * The same figures per liveness source.
   *
   * VISION §9 runs two INDEPENDENT sources and git-derived detection is
   * structurally slower than runner-reported. A blended number describes
   * neither, and hides which half needs work.
   */
  bySource: z.record(z.string(), latencyGroupSchema),
});

export class LatencySummaryResponseDto extends createZodDto(latencySummaryResponseSchema) {}
