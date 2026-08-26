import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `GET /api/audit-events` (#338, epic #332).
 *
 * `audit_events` has been written to since the foundation shipped —
 * `users.service.ts`, `allowlist.service.ts`, `objects.service.ts`,
 * `issue-gate.service.ts`, `queue-steering.service.ts`,
 * `never-trustable.service.ts`, both settings services — and `findMany` on it
 * appears nowhere in the API. Every one of those rows has been write-only for
 * the life of the project. The Control Center's History section is the first
 * thing that needs to read them, and this is that read path.
 *
 * `targetType` is the filter that matters, because it is what separates
 * "everything that ever happened" from "what changed about my settings":
 * `operator_settings` for this epic's own writes, `system_settings`,
 * `repository`, `work_order`, and so on. It is a free string rather than an
 * enum on purpose — the writers are spread across nine services and a closed
 * list here would silently stop matching the first time one of them added a
 * kind, which is worse than a filter that returns nothing for a typo.
 */
export const auditEventListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // The same 100 ceiling `userListQuerySchema` uses. An audit table grows
  // without bound, so an unbounded page size is a way to ask for the whole
  // history in one request.
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  /** `operator_settings`, `system_settings`, `user`, `repository`, … */
  targetType: z.string().min(1).optional(),
  /** Narrow to one subject — with `targetType`, one settings key. */
  targetId: z.string().min(1).optional(),
  /** `operator_settings:set`, `user.roles.update`, … */
  action: z.string().min(1).optional(),
  actorUserId: z.uuid().optional(),
  /** Inclusive lower bound on `createdAt`. */
  since: z.iso.datetime().optional(),
  /** Exclusive upper bound on `createdAt`. */
  until: z.iso.datetime().optional(),
  // Newest first by default: History is read to answer "what just changed",
  // and the answer is at the top.
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export class AuditEventListQueryDto extends createZodDto(
  auditEventListQuerySchema,
) {}
