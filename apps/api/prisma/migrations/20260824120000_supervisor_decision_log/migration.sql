-- The supervisor decision log (#90), which is the entire deliverable of Phase 6.
--
-- VISION §7's promotion ladder starts at rung 1: "the supervisor writes
-- proposals to a decision log and executes nothing." Without the log there is
-- no evidence, and without evidence promotion is a guess dressed as a process.

CREATE TYPE "SupervisorInvocationOutcome" AS ENUM (
  'completed',
  'partial',
  'failed',
  'skipped_disabled',
  'skipped_quota'
);

-- A declined proposal is still a row. #90: an action class that is never
-- proposed looks the same as one that is always proposed correctly, and the
-- approval rate #99 computes is biased unless the log can tell them apart.
CREATE TYPE "SupervisorProposalOutcome" AS ENUM ('proposed', 'declined');

CREATE TYPE "SupervisorProposalReview" AS ENUM (
  'pending',
  'would_approve',
  'would_reject'
);

-- One scheduled invocation, and the snapshot it saw.
--
-- The snapshot text is stored rather than re-derived: `SnapshotService` could
-- re-query Postgres, but it would re-query TODAY's Postgres, and a proposal
-- reviewed a week later would be judged against a factory that has moved.
CREATE TABLE "supervisor_invocations" (
  "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "started_at"            TIMESTAMPTZ NOT NULL,
  "finished_at"           TIMESTAMPTZ NOT NULL,
  "duration_ms"           INTEGER NOT NULL,
  "outcome"               "SupervisorInvocationOutcome" NOT NULL,
  "model"                 TEXT NOT NULL,
  "snapshot_text"         TEXT NOT NULL,
  "snapshot_hash"         TEXT NOT NULL,
  "snapshot_generated_at" TIMESTAMPTZ,
  "snapshot_truncated"    BOOLEAN NOT NULL DEFAULT FALSE,
  "snapshot_characters"   INTEGER NOT NULL DEFAULT 0,
  -- Supervisor cost lives in its own table, never on `runs`. #89 requires it
  -- not distort success metric 5: cost per merged pull request is about the
  -- work, and the supervisor merges nothing.
  "cost_usd"              DECIMAL(10,4),
  "tokens_input"          INTEGER,
  "tokens_output"         INTEGER,
  "failure_reason"        TEXT,
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "supervisor_invocations_started_at_idx"
  ON "supervisor_invocations" ("started_at");
CREATE INDEX "supervisor_invocations_outcome_started_at_idx"
  ON "supervisor_invocations" ("outcome", "started_at");

-- One thing the supervisor would have done, and executed nothing about.
--
-- There is deliberately no `executed_at`, no `applied_by`, no status meaning
-- "done". #90 requires execution be structurally impossible rather than merely
-- unimplemented, so the row cannot record an execution at all — a future change
-- that wants to execute has to add a column and say so in a migration.
--
-- `action_class` is TEXT, not an enum: ADR-0011 puts the taxonomy in
-- `apps/api/src/supervisor/action-classes.ts` and validates at the boundary,
-- because ADR-0010 makes an enum addition a MAJOR schema bump and adding an
-- action class as the supervisor grows is an ordinary event.
CREATE TABLE "supervisor_proposals" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "invocation_id"  UUID NOT NULL,
  "action_class"   TEXT NOT NULL,
  "outcome"        "SupervisorProposalOutcome" NOT NULL,
  "summary"        TEXT NOT NULL,
  "reasoning"      TEXT NOT NULL,
  "target_kind"    TEXT,
  -- Not a foreign key. A proposal about an issue with no work order yet has
  -- nothing to point at, and a proposal must outlive the row it discusses or
  -- the evidence disappears with it.
  "target_ref"     TEXT,
  "details"        JSONB,
  "review"         "SupervisorProposalReview" NOT NULL DEFAULT 'pending',
  "reviewed_at"    TIMESTAMPTZ,
  "reviewed_by_id" UUID,
  "review_note"    TEXT,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- No default: Prisma's @updatedAt always supplies it, and every other
  -- table in this schema is written the same way.
  "updated_at"     TIMESTAMPTZ NOT NULL
);

ALTER TABLE "supervisor_proposals"
  ADD CONSTRAINT "supervisor_proposals_invocation_id_fkey"
  FOREIGN KEY ("invocation_id") REFERENCES "supervisor_invocations" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull, not Cascade: the verdict outlives the account that recorded it.
ALTER TABLE "supervisor_proposals"
  ADD CONSTRAINT "supervisor_proposals_reviewed_by_id_fkey"
  FOREIGN KEY ("reviewed_by_id") REFERENCES "users" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "supervisor_proposals_invocation_id_idx"
  ON "supervisor_proposals" ("invocation_id");
-- The measurement query: per class, what fraction was approved.
CREATE INDEX "supervisor_proposals_action_class_review_idx"
  ON "supervisor_proposals" ("action_class", "review");
-- The review queue: what nobody has judged yet, oldest first.
CREATE INDEX "supervisor_proposals_review_created_at_idx"
  ON "supervisor_proposals" ("review", "created_at");
-- "What has been proposed about this run / work order".
CREATE INDEX "supervisor_proposals_target_kind_target_ref_idx"
  ON "supervisor_proposals" ("target_kind", "target_ref");
