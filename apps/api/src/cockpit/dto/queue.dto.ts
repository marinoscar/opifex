import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The queue, as the cockpit reads it.
 *
 * #80 asks for **read models, not table dumps**: the cockpit's question is
 * "what is the factory about to work on, and what is stopping it", and this
 * answers that directly rather than handing over `work_orders` rows for the
 * browser to interpret.
 *
 * Every field here exists because `apps/web/src/types/cockpit.ts` renders it.
 * That file is explicit that its shapes were a PROPOSAL written before any
 * endpoint existed and must be reconciled against the real response in the
 * same pull request — this schema is that reconciliation, so where the two
 * disagree the disagreement is resolved here and in that file together, never
 * by a component quietly reading `undefined`.
 */

/** How far the queue can be read in one request. */
export const QUEUE_MAX_LIMIT = 100;
export const QUEUE_DEFAULT_LIMIT = 25;

export const queueQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(QUEUE_MAX_LIMIT)
    .default(QUEUE_DEFAULT_LIMIT),
});

export class QueueQueryDto extends createZodDto(queueQuerySchema) {}

/**
 * Why a queued work order is not running yet.
 *
 * `held` is a POLICY outcome and the other three are SCHEDULING outcomes, and
 * the cockpit keeps them apart because they call for opposite responses: a
 * held work order clears when a human acts, a waiting one clears on its own.
 * Collapsing them into "not running" would ask the operator to guess which.
 *
 * `dispatching` is in the vocabulary and is deliberately never emitted today —
 * see `QueueService.stateOf`.
 */
export const queueEntryStateSchema = z.enum([
  'waiting',
  'ready',
  'dispatching',
  'held',
]);

/**
 * A work order, reduced to identity and a way back to GitHub.
 *
 * Both `id` and `branch` are carried rather than recomposed from the parts,
 * because a UI that re-derives an identifier can disagree with the control
 * plane about what a run IS — and re-run idempotency rests on that string
 * matching exactly (#62). The parts are here for display, never for
 * reconstruction.
 */
export const workOrderRefSchema = z.object({
  /** `wo_opifex_312_a3f91c2_a1`. */
  id: z.string(),
  issueNumber: z.number().int(),
  /** `owner/name`. */
  repository: z.string(),
  /**
   * The pinned base commit, SHORTENED TO 7 CHARACTERS here.
   *
   * The cockpit's type says "already shortened upstream", so the shortening is
   * the API's job. Sending the full 40 would render a chip nobody sized for,
   * and leaving it to the browser would put a second opinion about identity in
   * the one place #62 says must not have one.
   */
  baseCommit: z.string(),
  attempt: z.number().int(),
  branch: z.string(),
  title: z.string(),
  issueUrl: z.string().nullable(),
});

export const queueEntrySchema = z.object({
  id: z.uuid(),
  workOrder: workOrderRefSchema,
  state: queueEntryStateSchema,
  /** 1-based position in the order this list is in. */
  position: z.number().int(),
  enqueuedAt: z.iso.datetime(),
  /** What must clear first, in one line. Null when nothing blocks it. */
  waitingOn: z.string().nullable(),
});

export class QueueEntryDto extends createZodDto(queueEntrySchema) {}

export type QueueEntry = z.infer<typeof queueEntrySchema>;
export type QueueEntryState = z.infer<typeof queueEntryStateSchema>;
