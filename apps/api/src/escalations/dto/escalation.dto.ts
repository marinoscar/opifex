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
  raisedAt: z.iso.datetime(),
  dispatchedAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  acknowledgedAt: z.iso.datetime().nullable(),
  acknowledgedById: z.uuid().nullable(),
});

export class EscalationResponseDto extends createZodDto(escalationResponseSchema) {}
