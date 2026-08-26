import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * One row of the audit log, as it is served (#338).
 *
 * `actor` is nullable in two different ways and they mean different things.
 * `actorUserId` is null when nothing human did it — the reconciler, a cron
 * task, a startup convergence. `actor` is null while `actorUserId` is set when
 * the user has since been deleted (the relation is `onDelete: SetNull` on the
 * column, but a row read before that cascade, or a row whose actor was purged,
 * still needs to render). The id is therefore carried beside the object rather
 * than only inside it.
 */
export const auditEventResponseSchema = z.object({
  id: z.uuid(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  actorUserId: z.uuid().nullable(),
  actor: z
    .object({
      id: z.uuid(),
      email: z.string(),
      displayName: z.string().nullable(),
    })
    .nullable(),
  /**
   * Whatever the writer recorded, REDACTED again on the way out.
   *
   * Redaction already happens at write time (#337), which is the one that
   * actually protects the table — nothing added later removes a plaintext
   * secret from rows already on disk. This second pass is for the rows written
   * BEFORE that landed, and for any writer that forgets: an audit log is the
   * one table nobody is allowed to go back and rewrite, so the read path
   * declining to serve what should not be there costs a walk of a small object
   * and closes the gap for history that is already written.
   */
  meta: z.unknown().nullable(),
  createdAt: z.iso.datetime(),
});

export class AuditEventResponseDto extends createZodDto(
  auditEventResponseSchema,
) {}

export type AuditEventResponse = z.infer<typeof auditEventResponseSchema>;
