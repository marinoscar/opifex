import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const tickHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  /** Filter to one outcome — `completed`, `partial`, `skipped-locked`, ... */
  outcome: z.string().min(1).max(40).optional(),
  /**
   * Only ticks that computed at least one action.
   *
   * The review filter: a week is ~10,000 ticks, and in a healthy factory
   * almost all of them did nothing. Reading the week means reading the ones
   * that decided something.
   */
  actionsOnly: z.stringbool().optional(),
});

export class TickHistoryQueryDto extends createZodDto(tickHistoryQuerySchema) {}

export const tickRecordSchema = z.object({
  id: z.uuid(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.number().int(),
  outcome: z.string(),
  repositoriesObserved: z.number().int(),
  actionsComputed: z.number().int(),
  /** Zero for the whole observation week, by design (VISION §12). */
  actionsExecuted: z.number().int(),
  allFromCache: z.boolean(),
  rateLimitRemaining: z.number().int().nullable(),
  failures: z.unknown(),
  /** Null on a quiet tick — see the retention note on the Prisma model. */
  projections: z.unknown().nullable(),
  actions: z.unknown().nullable(),
});

export class TickRecordDto extends createZodDto(tickRecordSchema) {}
