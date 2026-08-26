/**
 * `GET /api/audit-events`, as the Control Center's History section reads it
 * (#351, epic #332).
 *
 * The shape mirrors `apps/api/src/audit-events/dto/audit-event-response.dto.ts`
 * exactly, including the two different ways an actor can be absent, because
 * they are two different facts:
 *
 *  - `actorUserId: null` — nothing human did it. The reconciler, a cron task,
 *    a startup convergence.
 *  - `actorUserId` set with `actor: null` — a person did it and that account
 *    has since been deleted (`onDelete: SetNull` on the column).
 *
 * A UI that collapsed both into "unknown" would report an automated change and
 * a departed administrator's change identically, which is the one question an
 * audit log exists to answer.
 *
 * `meta` is `unknown` and stays that way. Nine services write this column and
 * each writes its own shape; anything narrower here would be a claim about
 * writers this file has never seen. `config/auditHistory.ts` is where an
 * unknown `meta` is turned into something renderable — safely, because that is
 * also where the rule "a secret is never valued" is enforced.
 */

/** The person who acted, when the account still exists. */
export interface AuditActor {
  id: string;
  email: string;
  displayName: string | null;
}

/** One row of the audit log, as the API serves it. */
export interface AuditEvent {
  id: string;
  /** `operator_settings:set`, `user:roles_update`, `allowlist:add`, … */
  action: string;
  /** `operator_settings`, `system_settings`, `user`, `allowed_email`, … */
  targetType: string;
  /** The subject — a settings key, a user id, a repository identity. */
  targetId: string;
  actorUserId: string | null;
  actor: AuditActor | null;
  /** Whatever the writer recorded, redacted by the API on the way out. */
  meta: unknown;
  createdAt: string;
}

/** A page of audit events, newest first. */
export interface AuditEventsPage {
  items: AuditEvent[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
