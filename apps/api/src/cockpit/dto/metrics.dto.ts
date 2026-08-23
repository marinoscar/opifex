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

export const metricsSummarySchema = z.object({
  /** When the control plane COMPUTED these, not when the client fetched. */
  generatedAt: z.iso.datetime(),
  window: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
  metrics: z.record(metricIdSchema, metricSampleSchema),
});

export class MetricsSummaryDto extends createZodDto(metricsSummarySchema) {}

export type MetricSample = z.infer<typeof metricSampleSchema>;
export type MetricsSummary = z.infer<typeof metricsSummarySchema>;

/** A metric that is not measured yet. The only way to express "no data". */
export const NOT_MEASURED: MetricSample = { value: null, trend: [] };
