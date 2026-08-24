-- Trust grants (#96, epic #22): a scoped, expiring, budget-capped,
-- self-revoking authorization to skip an approval. VISION §8 / glossary:
-- "Never 'trust the agent.'"
--
-- The four attributes VISION §8 requires "attached automatically" - scope,
-- expiry, a budget ceiling, and auto-revoke thresholds - are NOT NULL with no
-- default here, per #96's first acceptance criterion: enforced at the
-- database level, not only by application code a caller could bypass.

-- `suspended` vs `revoked`: a suspension is the SYSTEM's judgement, on
-- evidence, and reversible by a human who disagrees with it. A revocation is
-- the HUMAN's judgement and is not reversible.
CREATE TYPE "TrustGrantStatus" AS ENUM (
  'active',
  'expired',
  'revoked',
  'suspended'
);

CREATE TYPE "TrustGrantEndReason" AS ENUM (
  'manual_revocation',
  'expired',
  'budget_exhausted',
  'failure_rate_exceeded',
  'cost_per_action_exceeded',
  'class_demoted',
  'superseded_by_renewal'
);

-- No unique constraint on (action_class, repository_id) for active grants,
-- deliberately: two overlapping active grants for the same scope are
-- legitimate (a renewal issued before the old one lapses), and a unique index
-- would force renewal to be delete-then-create, losing the chain
-- `renewed_from_id` carries.
CREATE TABLE "trust_grants" (
  "id"                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope: action class x repository. Never "trust the agent" - repository_id
  -- is NOT NULL with no "all repositories" representation.
  "action_class"                   TEXT NOT NULL,
  "repository_id"                  UUID NOT NULL,

  -- Expiry: no default. Expiry is the default outcome, not a reminder.
  "expires_at"                     TIMESTAMPTZ NOT NULL,

  -- Budget ceiling.
  "budget_ceiling_usd"             DECIMAL(10,4) NOT NULL,
  "spent_usd"                      DECIMAL(10,4) NOT NULL DEFAULT 0,
  "actions_authorized"             INTEGER NOT NULL DEFAULT 0,

  -- Auto-revoke thresholds.
  "max_failure_rate"               DECIMAL(4,3) NOT NULL,
  "max_cost_per_action_usd"        DECIMAL(10,4) NOT NULL,
  "min_actions_before_auto_revoke" INTEGER NOT NULL DEFAULT 3,
  "actions_failed"                 INTEGER NOT NULL DEFAULT 0,

  -- Lifecycle.
  "status"                         "TrustGrantStatus" NOT NULL DEFAULT 'active',
  "ended_at"                       TIMESTAMPTZ,
  "end_reason"                     "TrustGrantEndReason",
  "end_detail"                     TEXT,
  "revoked_by_id"                  UUID,
  "note"                           TEXT,

  "created_at"                     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- No default: Prisma's @updatedAt always supplies it, and every other
  -- table in this schema is written the same way.
  "updated_at"                     TIMESTAMPTZ NOT NULL,

  -- Provenance.
  "granted_by_id"                  UUID NOT NULL,
  "granted_from_proposal_id"       UUID,
  "renewed_from_id"                UUID
);

ALTER TABLE "trust_grants"
  ADD CONSTRAINT "trust_grants_repository_id_fkey"
  FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict, not Cascade or SetNull: a grant must always name the human who
-- authorized it, so deleting that user while a grant of theirs still exists
-- is refused rather than orphaning the grant's authority.
ALTER TABLE "trust_grants"
  ADD CONSTRAINT "trust_grants_granted_by_id_fkey"
  FOREIGN KEY ("granted_by_id") REFERENCES "users" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- SetNull: the grant outlives the proposal row losing its provenance
-- pointer rather than being deleted with it.
ALTER TABLE "trust_grants"
  ADD CONSTRAINT "trust_grants_granted_from_proposal_id_fkey"
  FOREIGN KEY ("granted_from_proposal_id") REFERENCES "supervisor_proposals" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Self-relation, SetNull: the renewal chain stays walkable even if an
-- ancestor grant row is later removed.
ALTER TABLE "trust_grants"
  ADD CONSTRAINT "trust_grants_renewed_from_id_fkey"
  FOREIGN KEY ("renewed_from_id") REFERENCES "trust_grants" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- SetNull, unlike granted_by_id's Restrict: a revocation is a safe act and
-- the grant is already over, so the record surviving the account is enough.
ALTER TABLE "trust_grants"
  ADD CONSTRAINT "trust_grants_revoked_by_id_fkey"
  FOREIGN KEY ("revoked_by_id") REFERENCES "users" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- THE authorization query: is there an active grant for this class in this
-- repository.
CREATE INDEX "trust_grants_action_class_repository_id_status_idx"
  ON "trust_grants" ("action_class", "repository_id", "status");
-- The expiry sweep, and the "expiring soon" query.
CREATE INDEX "trust_grants_status_expires_at_idx"
  ON "trust_grants" ("status", "expires_at");
CREATE INDEX "trust_grants_repository_id_idx"
  ON "trust_grants" ("repository_id");
CREATE INDEX "trust_grants_granted_by_id_idx"
  ON "trust_grants" ("granted_by_id");
-- "What did this user revoke" — the query the column exists for.
CREATE INDEX "trust_grants_revoked_by_id_idx"
  ON "trust_grants" ("revoked_by_id");
