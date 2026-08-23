import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Work orders, as the cockpit reads them.
 *
 * The detail endpoint serves the **authorized document** — rebuilt from the
 * row by `rehydrateWorkOrder` (#154) and shaped by `toWorkOrderDocument`, the
 * same function that produced the bytes committed to the branch and posted to
 * the issue (#63). That is what makes #84's authorization-record view a
 * comparison rather than an illustration: the operator is looking at the same
 * document, from the same serializer, not a second rendering of the same row.
 */

export const WORK_ORDERS_MAX_PAGE_SIZE = 100;
export const WORK_ORDERS_DEFAULT_PAGE_SIZE = 25;

export const workOrderStatusSchema = z.enum([
  'pending',
  'queued',
  'held',
  'dispatched',
  'succeeded',
  'failed',
  'quarantined',
  'superseded',
  'cancelled',
]);

export const workOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(WORK_ORDERS_MAX_PAGE_SIZE)
    .default(WORK_ORDERS_DEFAULT_PAGE_SIZE),
  status: workOrderStatusSchema.optional(),
  /** `owner/name`. */
  repository: z.string().min(3).max(200).optional(),
});

export class WorkOrdersQueryDto extends createZodDto(workOrdersQuerySchema) {}

/** A row, reduced to what a list renders. */
export const workOrderListItemSchema = z.object({
  id: z.uuid(),
  identity: z.string(),
  issueNumber: z.number().int(),
  issueTitle: z.string(),
  issueUrl: z.string().nullable(),
  repository: z.string(),
  /** Shortened to 7, like everywhere else the cockpit shows one. */
  baseCommit: z.string(),
  attempt: z.number().int(),
  branch: z.string(),
  status: workOrderStatusSchema,
  /** Why it is held or quarantined. Null for every other status. */
  holdReason: z.string().nullable(),
  queuedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** How many runs have been made against it. Attempt quality (#66). */
  runCount: z.number().int(),
});

export class WorkOrderListItemDto extends createZodDto(
  workOrderListItemSchema,
) {}

/**
 * The authorized document, exactly as `schemas/work-order.schema.json` defines
 * it and exactly as the execution record on the branch carries it.
 *
 * Modelled here rather than imported as `z.unknown()` so the endpoint's
 * OpenAPI description is honest about what comes back — but the VALUE is
 * produced by `toWorkOrderDocument`, never assembled a second time. Two call
 * sites building this shape independently is the thing
 * `work-order-document.ts` exists to prevent.
 */
export const workOrderDocumentSchema = z.object({
  schemaVersion: z.string(),
  identity: z.string(),
  branch: z.string(),
  repository: z.object({ owner: z.string(), name: z.string() }),
  baseCommit: z.string(),
  attempt: z.number().int(),
  issue: z.object({ number: z.number().int(), url: z.string() }),
  decisionRefs: z.array(z.string()).optional(),
  taskSpec: z.string(),
  acceptanceCriteria: z.array(z.string()),
  pathConstraints: z.array(z.string()),
  budgetCeilingUsd: z.number().nullable(),
  wallClockTimeoutMinutes: z.number().int().nullable(),
  needs: z.array(z.string()),
});

export const workOrderRunSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  runner: z.string(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  costUsd: z.number().nullable(),
  pullRequestUrl: z.string().nullable(),
});

export const workOrderDetailSchema = z.object({
  id: z.uuid(),
  status: workOrderStatusSchema,
  holdReason: z.string().nullable(),
  queuedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /**
   * The issue comment carrying the authorization record (#63).
   *
   * Null until dispatch posts it. This is the provenance link VISION §5 rests
   * on — the traversable edge from the work order to the human-readable proof
   * it was authorized — so it is a first-class field rather than something to
   * be reconstructed from the issue URL.
   */
  authorizationCommentUrl: z.string().nullable(),
  /** The base commit, IN FULL. See the note in `work-orders.service.ts`. */
  baseCommit: z.string(),
  document: workOrderDocumentSchema,
  runs: z.array(workOrderRunSchema),
});

export class WorkOrderDetailDto extends createZodDto(workOrderDetailSchema) {}

export type WorkOrderListItem = z.infer<typeof workOrderListItemSchema>;
export type WorkOrderDetail = z.infer<typeof workOrderDetailSchema>;
