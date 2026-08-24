-- Approval requests (#97, epic #22): "may this action proceed" - raised for a
-- human, or resolved without one, and kept either way as the auditable record
-- of what was asked and what happened. VISION §8.

-- `auto_approve`/`deny`/`park_and_escalate` - ADR-0014's total order over the
-- existing reversibility classification and `spendsMoney`, never a second
-- axis. Resolved once at raise time and recorded on the row (see
-- `timeout_policy` below) rather than recomputed later.
CREATE TYPE "ApprovalTimeoutPolicy" AS ENUM (
  'auto_approve',
  'deny',
  'park_and_escalate'
);

-- `approved`/`denied` are a human's verdict; `auto_approved`/`auto_denied`
-- are what happened because nobody answered before `timeout_at`. Kept as
-- four values, not a boolean, so #99's promotion ladder never counts a
-- timeout as evidence of human agreement (or disagreement).
CREATE TYPE "ApprovalStatus" AS ENUM (
  'pending',
  'approved',
  'denied',
  'auto_approved',
  'auto_denied',
  'parked',
  'superseded'
);

-- `human`/`timeout`/`grant` - HOW a resolved request actually got resolved.
CREATE TYPE "ApprovalDecidedVia" AS ENUM (
  'human',
  'timeout',
  'grant'
);

CREATE TABLE "approval_requests" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  "action_class"        TEXT NOT NULL,
  "repository_id"       UUID NOT NULL,
  "proposal_id"         UUID,

  "target_kind"         TEXT,
  "target_ref"          TEXT,

  "summary"             TEXT NOT NULL,
  "reasoning"           TEXT NOT NULL,
  "blast_radius"        TEXT NOT NULL,

  -- The AutonomyEffect[] (ADR-0013) this action declared at raise time.
  "effects"             JSONB NOT NULL,

  -- NULL means UNKNOWN, not zero (VISION §6).
  "estimated_cost_usd"  DECIMAL(10,4),

  -- Resolved at raise time from the registry and frozen here - not
  -- recomputed at resolution time. See the schema doc comment.
  "timeout_policy"      "ApprovalTimeoutPolicy" NOT NULL,
  -- NULL for park_and_escalate: that policy has no timer, ever. The null IS
  -- the "never auto-approve" guarantee expressed in data.
  "timeout_at"          TIMESTAMPTZ,

  "status"              "ApprovalStatus" NOT NULL DEFAULT 'pending',

  "decided_at"          TIMESTAMPTZ,
  "decided_by_id"       UUID,
  "decided_via"         "ApprovalDecidedVia",
  "decision_note"       TEXT,

  -- The grant that authorized this action, when one did.
  "grant_id"            UUID,
  -- The grant MINTED from this approval, when "Always approve this class"
  -- was chosen. Deliberately separate from grant_id - see the schema doc
  -- comment for why collapsing the two loses information #100's digest needs.
  "created_grant_id"    UUID,

  -- Set only when timeout_policy is park_and_escalate.
  "escalation_id"       UUID,

  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- No default: Prisma's @updatedAt always supplies it, and every other
  -- table in this schema is written the same way.
  "updated_at"          TIMESTAMPTZ NOT NULL
);

ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_repository_id_fkey"
  FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull: the approval record outlives the proposal row losing its
-- provenance pointer, matching trust_grants.granted_from_proposal_id.
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_proposal_id_fkey"
  FOREIGN KEY ("proposal_id") REFERENCES "supervisor_proposals" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- SetNull: the approval record outlives the account that decided it.
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_decided_by_id_fkey"
  FOREIGN KEY ("decided_by_id") REFERENCES "users" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- SetNull: the approval record outlives the grant that authorized it.
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_grant_id_fkey"
  FOREIGN KEY ("grant_id") REFERENCES "trust_grants" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- SetNull: the approval record outlives the grant it created.
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_created_grant_id_fkey"
  FOREIGN KEY ("created_grant_id") REFERENCES "trust_grants" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- SetNull: the approval record outlives the escalation row losing its
-- pointer.
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_escalation_id_fkey"
  FOREIGN KEY ("escalation_id") REFERENCES "escalations" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The sweeper's query: what is pending and due.
CREATE INDEX "approval_requests_status_timeout_at_idx"
  ON "approval_requests" ("status", "timeout_at");
-- #99's per-class measurement.
CREATE INDEX "approval_requests_action_class_status_idx"
  ON "approval_requests" ("action_class", "status");
CREATE INDEX "approval_requests_repository_id_status_idx"
  ON "approval_requests" ("repository_id", "status");
-- The pending queue, oldest first.
CREATE INDEX "approval_requests_status_created_at_idx"
  ON "approval_requests" ("status", "created_at");
-- #100's per-grant attribution.
CREATE INDEX "approval_requests_grant_id_idx"
  ON "approval_requests" ("grant_id");
