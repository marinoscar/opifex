-- A manual promotion demotion that HOLDS, and an actor recorded as an edge
-- (#244, epic #22, VISION §7 "Earned autonomy").
--
-- Two halves of the same bug.
--
-- 1. THE HOLD. `POST /api/promotion/states/:actionClass/demote` was half
--    durable. The grant suspension held - nothing re-creates a suspended grant
--    except a human tap - but the RUNG did not. `evaluateLadder`'s promotion
--    rule gates on "not currently promoted", and a hand-demotion leaves a class
--    exactly there, so the hourly evaluation saw a non-promoted class with the
--    same good lifetime record and put it straight back on `promoted` with
--    `change_reason = 'promoted_on_evidence'`, typically within the hour.
--
--    The anti-oscillation guard did not cover this. It refuses to promote a
--    class that is currently FAILING the recent window - which is the case the
--    ladder would have demoted on its own. #244 is about the operator who has
--    evidence the numbers do not yet show, i.e. the numbers are good, i.e. the
--    guard never fires.
--
--    `manual_hold_until` is the missing state. While it is in the future the
--    ladder may not promote the class; the read model reports it, so the
--    operator can see the term of their own decision.
--
-- 2. THE ACTOR. Who demoted a class survived only as prose inside
--    `change_detail`. `trust_grants.revoked_by_id` is a column precisely
--    because a provenance edge that lives only in a sentence is a hole in
--    VISION §5's graph, and holes are not detectable after the fact:
--    "which demotions were a human's" is not answerable by substring search.
--    `changed_by_id` closes it.
--
-- No new `promotion_change_reason` enum value. A hand-demotion already writes
-- `demoted_manually`, and the hold is a PROPERTY of that demotion rather than a
-- separate kind of transition - a third reason meaning "held" would make the
-- same event representable two ways.

-- Nullable, no default, no backfill.
--
-- Every existing row's last rung change was made by the ladder or by a
-- hand-demotion whose actor is recoverable only from `change_detail`. NULL is
-- the honest answer for both: inventing an actor for the automatic ones would
-- be worse than the gap, and parsing the prose for the manual ones would
-- fabricate an edge from a string. The column starts telling the truth from the
-- next rung change onwards.
--
-- SetNull on the user, matching `trust_grants.revoked_by_id`: the rung change
-- is already over, so the record surviving a deleted account is enough. A
-- Restrict here would let a stale ladder row block deleting a user.
ALTER TABLE "promotion_states"
  ADD COLUMN "changed_by_id" UUID;

ALTER TABLE "promotion_states"
  ADD CONSTRAINT "promotion_states_changed_by_id_fkey"
  FOREIGN KEY ("changed_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- "What did this user demote." A small table today, but the index is the
-- reason the column is a column rather than prose: an edge nobody can query is
-- not much better than a sentence.
CREATE INDEX "promotion_states_changed_by_id_idx"
  ON "promotion_states"("changed_by_id");

-- An INSTANT rather than a boolean flag, and no default.
--
-- The term (14 days, `MANUAL_HOLD_DAYS`, tied to `REGRESSION_WINDOW_DAYS`)
-- belongs to `apps/api/src/promotion/promotion-policy.ts`. A DEFAULT here that
-- computed an expiry would be a second copy of that decision living in a place
-- nobody reviewing the policy would look, and the two would drift the first
-- time the window was tuned.
--
-- NULL means "never held by hand". A value in the PAST means "was held, and
-- the hold has lapsed" - the application shortens no hold and clears no value,
-- so the row keeps saying that a human held this class down and until when,
-- long after the ladder has taken over again.
--
-- No backfill: existing rows have never been held, which is true.
--
-- No index. The only read is per-row, on a table with one row per action class
-- in a taxonomy of a handful of entries, always reached by the unique
-- `action_class` key. An index would cost every write and serve no query.
ALTER TABLE "promotion_states"
  ADD COLUMN "manual_hold_until" TIMESTAMPTZ;
