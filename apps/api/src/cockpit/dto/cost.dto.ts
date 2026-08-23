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
  days: z.coerce.number().int().min(1).max(COST_MAX_DAYS).default(COST_DEFAULT_DAYS),
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
});

export class CostSummaryDto extends createZodDto(costSummarySchema) {}

export type CostSummary = z.infer<typeof costSummarySchema>;
