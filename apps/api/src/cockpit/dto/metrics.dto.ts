import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The six success metrics (VISION §10), which opens: *"Six metrics. The web
 * application exists primarily to show them."*
 *
 * ## The honesty contract is this file's entire job
 *
 * `value` is `number | null` and null renders as an em dash. The cockpit's
 * `MetricTile` has NO code path from `null` to `0` — that is structural there,
 * not a convention — and this endpoint must not undo it from the other side.
 *
 * **A metric with no data returns null, never 0.** A zero detection latency is
 * a spectacular claim to make by accident: it says the system noticed every
 * stall instantly, when what actually happened is that nothing was measured.
 * `escalations/detection-latency.ts` already reasons this way in prose — *"Zero
 * milliseconds is an excellent latency and 'we measured nothing' is not a
 * latency at all"* — and this is the same rule applied to all six.
 *
 * Four of the six return null today and `metrics.service.ts` says why for
 * each. That is the correct answer, not a gap to fill with something
 * plausible.
 */

/** How far back the window reaches, in days. */
export const METRICS_MAX_DAYS = 90;
export const METRICS_DEFAULT_DAYS = 7;

export const metricsQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(METRICS_MAX_DAYS)
    .default(METRICS_DEFAULT_DAYS),
});

export class MetricsQueryDto extends createZodDto(metricsQuerySchema) {}

export const metricIdSchema = z.enum([
  'detectionLatency',
  'deadTimePerDay',
  'firstPassAcceptance',
  'attemptsPerWorkOrder',
  'costPerMergedPr',
  'quotaBurn',
]);

export type MetricId = z.infer<typeof metricIdSchema>;

/**
 * VISION §10's table order, which is also cockpit display order — from the
 * original complaint outward to scheduling health. Not alphabetical.
 */
export const METRIC_IDS: readonly MetricId[] = [
  'detectionLatency',
  'deadTimePerDay',
  'firstPassAcceptance',
  'attemptsPerWorkOrder',
  'costPerMergedPr',
  'quotaBurn',
];

export const metricSampleSchema = z.object({
  /** Null means "not measured", NEVER "zero". */
  value: z.number().nullable(),
  /**
   * How this number was computed, when it rests on a convention that could
   * defensibly have gone the other way.
   *
   * Optional, and absent for most metrics — a basis on a number with no
   * judgement behind it would be noise. `deadTimePerDay` carries one because
   * it rests on three choices at once (#232): parked time counts as dead time,
   * an interval spanning a day boundary is split across the days it occupies,
   * and an interval still open is counted up to now rather than dropped.
   *
   * Stated here as well as in `schema.prisma` because a schema comment is
   * invisible to somebody reading a dashboard tile, and a number that depends
   * on three conventions and states none of them cannot be checked.
   */
  basis: z.string().optional(),
  /**
   * The sparkline series, oldest first.
   *
   * Only buckets that HAD data appear. A metric cannot express a gap — the
   * array is `number[]` with no nulls — so emitting a 0 for a quiet day would
   * draw a line through the floor and claim the system was perfect that day.
   * A shorter array is the honest representation of a sparser window.
   *
   * An empty or one-point array draws NOTHING, by `Sparkline`'s own rule,
   * rather than a flat line implying stability nobody measured.
   */
  trend: z.array(z.number()),
});

/**
 * Parks that quota-aware routing prevented, over the window (#264).
 *
 * ## It sits BESIDE metric 2, and the shape is what keeps it there
 *
 * `avoidedQuotaPark` (#105) is a counterfactual: the park did not happen, so
 * there is no interval and there are no hours. The only way to produce hours
 * would be to estimate how long the park WOULD have lasted, which is the
 * substitution `metrics.service.ts` refuses for `quotaBurn` and which #232
 * declined to make here. *"14 parks avoided this week"* is honest; *"9.2 hours
 * of dead time avoided"* is not.
 *
 * So this is deliberately NOT a `MetricSample` and deliberately NOT a member
 * of the `metrics` record. Three structural consequences, each of which was
 * the point:
 *
 *  - Nothing can iterate `METRIC_IDS` and find it, so it can never render as a
 *    seventh tile with a unit formatter attached.
 *  - It has no `value` field, so it cannot be passed to anything that expects
 *    one — the cockpit's `MetricTile` takes `value` and a unit, and this shape
 *    simply does not fit it.
 *  - It has no duration anywhere, so there is nothing to add to
 *    `deadTimePerDay`.
 *
 * ## No trend, on purpose
 *
 * A count of a thing that is zero by construction until a second runner exists
 * would draw a flat line at the floor, which `Sparkline` would render as a
 * claim nobody measured. The window count plus `basis` says everything true
 * about it today. A trend is additive later, if the number ever moves.
 */
export const avoidedParksSchema = z.object({
  /**
   * How many parks were avoided in the window.
   *
   * Null means NOT MEASURED — nothing dispatched at all, so routing never had
   * the chance to move anything. **Zero is different and is a real reading**:
   * work was dispatched and none of it moved off a spent runner. With today's
   * single-runner fleet that zero is the honest and permanent answer, and it
   * must not read as an absence of data.
   */
  count: z.number().int().nullable(),
  /**
   * Which runner the work moved OFF, and how often.
   *
   * The reason this endpoint returns more than an integer: *"work moved off
   * claude-code-local 14 times while it was rate-limited"* is a sentence an
   * operator can act on, and *"14"* is not. Ordered by count descending, then
   * key, so the sentence is stable between polls.
   *
   * A dispatch that moved off two spent runners at once contributes to both
   * entries, so these sum to at least `count` and may exceed it. They are an
   * attribution, not a partition — which is exactly why `count` is reported
   * separately rather than derived from this list.
   */
  byExhaustedRunner: z.array(
    z.object({ runnerKey: z.string(), count: z.number().int() }),
  ),
  /** When the most recent one happened, ISO-8601, or null if there were none. */
  mostRecentAt: z.iso.datetime().nullable(),
  /**
   * What the number rests on, in one sentence.
   *
   * Always present, unlike `MetricSample.basis`, because this number needs it
   * more than any metric does: a zero here is the expected reading and the
   * basis is what stops it looking like a broken panel.
   */
  basis: z.string(),
});

export const metricsSummarySchema = z.object({
  /** When the control plane COMPUTED these, not when the client fetched. */
  generatedAt: z.iso.datetime(),
  window: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
  metrics: z.record(metricIdSchema, metricSampleSchema),
  /**
   * Context for metric 2, and a sibling of `metrics` rather than a member.
   *
   * See `avoidedParksSchema`. If this is ever summed with `deadTimePerDay`, or
   * rendered in hours, that is the failure #264 exists to prevent.
   */
  avoidedParks: avoidedParksSchema,
});

export class MetricsSummaryDto extends createZodDto(metricsSummarySchema) {}

export type MetricSample = z.infer<typeof metricSampleSchema>;
export type MetricsSummary = z.infer<typeof metricsSummarySchema>;
export type AvoidedParks = z.infer<typeof avoidedParksSchema>;

/** A metric that is not measured yet. The only way to express "no data". */
export const NOT_MEASURED: MetricSample = { value: null, trend: [] };

/**
 * No dispatches in the window, so nothing could have been avoided.
 *
 * The counterpart to `NOT_MEASURED`, and the reason `count` is nullable at
 * all. A freshly deployed control plane that has never dispatched anything has
 * not measured zero avoided parks — it has not measured.
 */
export const NO_DISPATCHES: AvoidedParks = {
  count: null,
  byExhaustedRunner: [],
  mostRecentAt: null,
  basis:
    'Not measured: nothing was dispatched in this window, so quota-aware ' +
    'routing never had the chance to move any work.',
};
