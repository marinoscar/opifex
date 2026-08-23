import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * What the factory has spent, and how much of that is actually known.
 *
 * ## The field that makes this honest is `runsWithoutCost`
 *
 * `Run.costUsd` is nullable because a runner may not report cost at all — the
 * capability manifest has `reportsCost` for exactly that reason (#32), and a
 * runner that does not report it is a supported case, not a broken one.
 *
 * So a total of $12 over a window where eight of ten runs reported nothing is
 * **not** "$12 spent". It is "$12 observed, and eight runs whose cost is
 * unknown". A summary that showed only the total would understate spend while
 * looking precise, which is the most expensive way for a cost screen to be
 * wrong — VISION §10 makes cost per merged PR the economic-viability metric,
 * and an understated denominator flatters it.
 *
 * `totalUsd` is null, never 0, when nothing reported a cost. "No run reported
 * a cost" and "the factory spent nothing" are different claims.
 */

export const COST_MAX_DAYS = 90;
export const COST_DEFAULT_DAYS = 30;

export const costQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(COST_MAX_DAYS)
    .default(COST_DEFAULT_DAYS),
});

export class CostQueryDto extends createZodDto(costQuerySchema) {}

export const repositorySpendSchema = z.object({
  /** `owner/name`. */
  repository: z.string(),
  /** Null when no run in this repository reported a cost. */
  totalUsd: z.number().nullable(),
  runs: z.number().int(),
  runsWithoutCost: z.number().int(),
});

export const dailySpendSchema = z.object({
  /** `YYYY-MM-DD`, UTC. */
  date: z.string(),
  totalUsd: z.number(),
});

/**
 * The hard spend ceiling, as the cockpit sees it (#177).
 *
 * A limit an operator cannot see the state of is one they will assume is
 * working. The ceiling is enforced whether or not this field is read, but an
 * install that has not set one gets NO other signal at all short of reading
 * the boot log — and the failure mode there is the quiet one: dispatch refuses
 * every work order and the queue looks like a capacity problem.
 *
 * Read-only in every direction. This reports the ceiling; nothing writes it
 * through the API, because VISION §8 puts it on the never-trustable list and
 * an endpoint that could set it would be exactly the trust grant §8 forbids.
 */
export const spendCeilingSchema = z.object({
  /**
   * Dollars. Null means none is configured, which REFUSES dispatch rather
   * than permitting it — so a null here is a blocked factory, not a free one.
   */
  limitUsd: z.number().nullable(),
  /** The rolling window the ceiling applies over. */
  windowDays: z.number().int(),
  /**
   * The offending text when the ceiling is set but unreadable.
   *
   * Carried separately from `limitUsd` so a typo never renders as "no ceiling
   * configured" — that is the case where somebody believed they had set one,
   * and telling them it is unset sends them to fix a variable that is set.
   */
  malformed: z.string().nullable(),
  /**
   * Spend against the ceiling, over the CEILING's window.
   *
   * Deliberately not the totals above, which cover whatever window the caller
   * asked for. A headroom figure computed over a different window than the
   * ceiling it is compared against would be wrong in a way nothing on screen
   * could reveal.
   */
  spend: z.object({
    /** Measured. */
    reportedUsd: z.number(),
    /**
     * ESTIMATED, from the authorized ceilings of runs that reported nothing.
     * Never folded into `reportedUsd`; the two are different kinds of claim.
     */
    estimatedUsd: z.number(),
    /** `reportedUsd + estimatedUsd`. A FLOOR when `unboundedRuns` is above 0. */
    totalUsd: z.number(),
    runsWithoutCost: z.number().int(),
    /**
     * Runs with neither a reported cost nor a ceiling to bound them.
     *
     * Above zero means `totalUsd` is a floor rather than a total, and the
     * screen must say so rather than drawing a headroom bar that implies
     * precision it does not have.
     */
    unboundedRuns: z.number().int(),
  }),
  /** `limitUsd - spend.totalUsd`. Null when no ceiling is configured. */
  headroomUsd: z.number().nullable(),
});

export const costSummarySchema = z.object({
  generatedAt: z.iso.datetime(),
  window: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
  /** Null when NO run reported a cost. Never 0 for "unmeasured". */
  totalUsd: z.number().nullable(),
  /** Runs started in the window, whether or not they reported a cost. */
  runs: z.number().int(),
  /**
   * How many of those reported nothing.
   *
   * The honesty half of the total. Read the two together or the number above
   * is a floor being presented as a figure.
   */
  runsWithoutCost: z.number().int(),
  byRepository: z.array(repositorySpendSchema),
  /** Only days that had reported spend, oldest first. */
  byDay: z.array(dailySpendSchema),
  /**
   * Quota, which is NOT measured.
   *
   * Carried as an explicit, always-null field rather than omitted, because a
   * cost-and-quota screen (#86) that simply had no quota section would look
   * like quota was forgotten rather than unavailable. VISION §11's shared
   * quota is the agent subscription, and nothing records consumption against
   * a window capacity — `RunEvent.blockedUntil` holds a reset TIME, never a
   * burn rate. This is the same absence that made `quotaBurn` null in #165,
   * and it is named here so the screen can say so.
   */
  quota: z.null(),
  /**
   * The hard spend ceiling (#177), and how much of it is left.
   *
   * Unlike `quota`, this IS measured — which is why it is an object rather
   * than the null beside it. The two sit together deliberately: one is a
   * limit the factory enforces and can report, the other is a limit it is
   * subject to and cannot.
   */
  ceiling: spendCeilingSchema,
});

export class CostSummaryDto extends createZodDto(costSummarySchema) {}

export type CostSummary = z.infer<typeof costSummarySchema>;
