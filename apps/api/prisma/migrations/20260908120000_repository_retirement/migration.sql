-- Retiring a repository, as an explicit stored fact (#405, epic #403).
--
-- `DELETE /api/repositories/:id` is deliberately refused while a repository
-- has work orders, because deleting would cascade its runs and their
-- provenance away and VISION §5's premise is that a hole in that graph is not
-- detectable after the fact. So the only removal action available fails on
-- exactly the repositories an operator most wants to tidy: the used ones.
-- RETIRE is the operation the system actually wants — stand the repository
-- down, the whole ladder off, in one auditable act, while the runs stay.
--
-- WHY TWO COLUMNS RATHER THAN NO COLUMNS
--
-- "Retired" could have been derived: all four of `observe_enabled`,
-- `mirror_labels_enabled`, `spec_feedback_enabled` and `dispatch_enabled`
-- off, for the price of no migration at all. That reading was considered and
-- rejected. All four off is reachable by four independent PATCHes, or by one
-- registration that passes `observeEnabled: false`, so it cannot distinguish
-- a deliberate stand-down from an operator who muted observation for an
-- afternoon — and those are different facts about intent. It also leaves
-- un-retire with nothing to undo, since nothing would record that the
-- repository had ever been retired, and it would make the audit row the only
-- trace of the act, so "is this retired now?" could be answered only by
-- replaying the audit log against every later PATCH.
--
-- The full argument, with the alternative stated fairly, is on the
-- `Repository` model in prisma/schema.prisma.
--
-- NULLABLE, NO DEFAULT, NO BACKFILL. NULL means "never retired", which is
-- true of every row that exists today. Nothing here changes an existing row,
-- and nothing here changes what `DELETE` does.
ALTER TABLE "repositories"
  ADD COLUMN "retired_at" TIMESTAMPTZ;

-- The actor, as an edge rather than as prose inside `audit_events.meta`.
-- Same reasoning as `promotion_states.changed_by_id` (#244): a provenance edge
-- that lives only in a JSON blob is not answerable by query, and "which
-- repositories did this operator stand down" is a question somebody will ask.
--
-- SetNull, matching that column: the decision is over by the time the account
-- is deleted, so the record surviving is enough, and a Restrict here would let
-- a retired repository block deleting a user.
ALTER TABLE "repositories"
  ADD COLUMN "retired_by_id" UUID;

ALTER TABLE "repositories"
  ADD CONSTRAINT "repositories_retired_by_id_fkey"
  FOREIGN KEY ("retired_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- "What did this user retire." The index is the reason the actor is a column
-- at all rather than a sentence.
CREATE INDEX "repositories_retired_by_id_idx"
  ON "repositories"("retired_by_id");

-- No index on `retired_at`. The list endpoint filters on it, but the whole
-- registry is a table an operator scrolls — tens of rows, not millions — and
-- the planner will sequential-scan it whatever we build. An index here would
-- cost every reconciler write of `last_observed_at` and serve no query that is
-- slow.
