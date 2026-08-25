import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The agent subscription's windows, as a screen can honestly show them (#231).
 *
 * ## Read `burnFraction` first, because it is always null
 *
 * VISION §10's sixth success metric is quota BURN — consumption over window
 * capacity. It is not computed here, or anywhere, and the field is carried as
 * an explicit null rather than omitted for the reason `CostSummaryDto.quota`
 * gives: a section that simply is not there reads as forgotten, and this one is
 * a decision.
 *
 * Two independent reasons, either of which would be enough:
 *
 *  - **No capacity is published.** #102 established there is no
 *    non-interactive vendor API, and no runner can declare a window limit —
 *    `runner-capability.schema.json` has no field for one. An operator-typed
 *    ceiling would be a guess sitting in a denominator.
 *  - **The consumption below is Opifex's own.** VISION §11 shares this
 *    subscription with the operator's interactive use, which burns the same
 *    window and leaves no record here. So the numerator is incomplete by an
 *    amount nothing can observe.
 *
 * What replaces it is a window that is real (`resetsAt` is the vendor's own),
 * a pressure the vendor stated itself, and a consumption figure named for
 * whose it is.
 *
 * ## Every live window is carried, and one of them binds (#301)
 *
 * This used to report ONE window per runner — the newest live one — which is
 * the least useful choice available, because a `weekly` row almost always
 * resets later than a `five_hour` one. An exhausted five-hour window was
 * therefore hidden behind a healthy weekly window, and the panel said a runner
 * was fine while it could not take work for four hours.
 *
 * The shape now says both halves of the one fact an operator is actually
 * asking about. `QuotaRunnerReadingDto.windows` is EVERY live window, soonest
 * reset first, because "fine for the week, out for the next four hours" is one
 * sentence and showing one window means picking which half of it to hide.
 * `QuotaRunnerReadingDto.position` is the single binding answer to "can this
 * runner work right now", and it is computed by the same `meterQuotaPosition`
 * that routing consumes — not by a second implementation of the same rule.
 */

/**
 * How the vendor described its own position. An ORDINAL, not a percentage.
 *
 * `warning` is the one worth building on: it is the vendor saying "approaching
 * the limit" while still serving requests, and it is the only signal in the
 * system that arrives BEFORE a run is parked.
 */
export const quotaPressureSchema = z.enum([
  'unknown',
  'allowed',
  'warning',
  'exhausted',
]);

export const opifexConsumptionSchema = z.object({
  /** Runs of this runner that started inside the span. */
  runs: z.number().int(),
  /**
   * How many reported no cost. The honesty half of `reportedUsd`.
   *
   * Read the two together, exactly as on the cost screen: a runner that does
   * not report cost is a supported case (`reportsCost` in the manifest), and a
   * total that ignored those runs would understate consumption while looking
   * precise.
   */
  runsWithoutCost: z.number().int(),
  /** Null, never 0, when no event in the span reported a cost. */
  reportedUsd: z.number().nullable(),
  tokensInput: z.number().int().nullable(),
  tokensOutput: z.number().int().nullable(),
});

/**
 * The single binding answer to "can this runner work right now".
 *
 * Structurally identical to `RunnerQuotaPosition` in `dispatch/dispatch-policy.ts`,
 * and produced by the same function — `meterQuotaPosition`. That is the point
 * of the field: #301 was filed because the cockpit and routing were answering
 * one question from two code paths, and only one of them was right. They now
 * agree by construction rather than by coincidence.
 *
 * Null means UNKNOWN, not healthy. It is what you get when every live window
 * reads `unknown`, or when the only non-exhausted readings are older than the
 * meter's health horizon (`QUOTA_METER_HEALTH_HORIZON_MS`) — a stale `allowed`
 * is no news about a subscription VISION §11 shares with the operator. The
 * `windows` list still carries those readings with their `lastObservedAt`, so
 * a screen can show what was seen and when while the position declines to
 * vouch for it.
 */
export const quotaPositionSchema = z.object({
  /** True only when an observed, dated block is still in force. */
  exhausted: z.boolean(),
  /**
   * When it lifts, or null when nothing could date it.
   *
   * The LATEST reset among the exhausted windows, never the earliest: the
   * runner is not usable again until the last binding ceiling has rolled, and
   * reporting the soonest would promise a refill the other limit will refuse.
   */
  resumesAt: z.string().nullable(),
  /** The observation this was derived from, in words. */
  basis: z.string(),
});

export const quotaWindowReadingSchema = z.object({
  /** The vendor's own label, verbatim: `five_hour`, `weekly`, or `unknown`. */
  windowKind: z.string(),
  /** When the vendor said this window rolls. The window's identity. */
  resetsAt: z.string(),
  /** Where consumption is measured from. */
  startedAt: z.string(),
  /**
   * On whose authority that start is claimed.
   *
   * `vendor-window-length` derives it from the label's own duration;
   * `first-observation` means the label named no length this system knows, or
   * the derived start predates the first sighting.
   */
  startedAtBasis: z.enum(['vendor-window-length', 'first-observation']),
  /**
   * True when the span starts at a sighting rather than the real boundary.
   *
   * Consumption is then a FLOOR for the window: whatever ran before the first
   * sighting is inside the window and outside the sum.
   */
  partialWindow: z.boolean(),
  /** The latest reading. */
  pressure: quotaPressureSchema,
  /**
   * The worst reading seen in this window.
   *
   * Kept beside `pressure` because `pressure` forgets: a window that was
   * refused at noon reads `allowed` again at one o'clock, and only this field
   * still says the wall was hit.
   */
  peakPressure: quotaPressureSchema,
  lastObservedAt: z.string(),
  /** How many lines carried this window. Not a consumption measure. */
  observations: z.number().int(),
  /**
   * Consumption Opifex ITSELF put through the window. Never the window's total.
   *
   * Named for whose it is at every layer it crosses, on the same principle
   * `SpendTally.estimatedUsd` follows: a qualification that is not in the
   * field name stops being distinguishable one call site later.
   */
  opifexConsumption: opifexConsumptionSchema,
  /** Always null. See this file's header. */
  burnFraction: z.null(),
  /** One paragraph naming what the numbers above are and are not. */
  basis: z.string(),
});

export const quotaRunnerReadingSchema = z.object({
  runnerKey: z.string(),
  /**
   * Which window binds, and when it releases. Null is UNKNOWN, not healthy.
   *
   * Read this to answer "can this runner work now". Read `windows` to see
   * why. See {@link quotaPositionSchema}.
   */
  position: quotaPositionSchema.nullable(),
  /**
   * EVERY window of this runner's that has not yet rolled, soonest reset first.
   *
   * Soonest first because the nearest ceiling is the one most likely to bind,
   * and an operator reading top-down should meet it before the distant one.
   * More than one entry is the normal case, not an anomaly: a runner routinely
   * holds a `five_hour` and a `weekly` row at once, and two of a kind whenever
   * the vendor's reported reset drifts.
   */
  windows: z.array(quotaWindowReadingSchema),
});

export const quotaSummarySchema = z.object({
  generatedAt: z.string(),
  /**
   * One entry per runner with a live window. EMPTY is a real answer.
   *
   * A fleet whose runners report no rate-limit signal at all
   * (`rateLimitSignal: 'none'`) has an unknown quota position, not a healthy
   * one — which is why an unobserved runner is absent rather than present with
   * zeroes. #231's last acceptance criterion is exactly this case.
   */
  runners: z.array(quotaRunnerReadingSchema),
});

export class QuotaSummaryDto extends createZodDto(quotaSummarySchema) {}

export type QuotaSummary = z.infer<typeof quotaSummarySchema>;
