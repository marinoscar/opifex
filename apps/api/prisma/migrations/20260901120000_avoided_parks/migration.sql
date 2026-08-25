-- Avoided parks (#264), so the countable event behind quota-aware routing is
-- something you can count.
--
-- #105 added `DispatchDecision.avoidedQuotaPark` and said what it was for:
-- "counting these over time is the before-and-after measure of VISION §10's
-- metric 2." Nothing counted it. The boolean went to a single log line with a
-- fixed prefix and then died with the in-memory decision, so "over time" meant
-- grepping container logs, which is not a measurement anybody will take.
-- #232 has since landed `dead_intervals` and metric 2 computes; this is the
-- half that says what quota-aware routing bought.
--
-- A COUNT OF EVENTS. Never a duration.
--
-- The park did not happen, so there is no interval to measure. Producing hours
-- from this table would mean estimating how long the avoided park WOULD have
-- lasted - `resumes_at` minus the decision instant - which is an estimate
-- wearing a measurement's clothes, is the exact substitution
-- `cockpit/metrics.service.ts` refuses for `quotaBurn`, and is what #232
-- declined to build here for the same reason. "14 parks avoided this week" is
-- honest; "9.2 hours of dead time avoided" is not. Hence: no duration column,
-- and a count that renders BESIDE metric 2 rather than inside it.
--
-- A table rather than a column on `runs`, for four reasons. The explanatory
-- facts are plural (a list of runner keys, each with a reset time), which is
-- three or four sparse columns on the widest table in the schema for a fact
-- false on nearly every row. Counting wants a window scan, which here is an
-- index on `occurred_at` over one row per event rather than a predicate on a
-- near-uniformly-false boolean. `dead_intervals` already set the precedent for
-- metric 2's own ledger and its neighbour should read the same way. And the
-- cascade below retracts the record for free in the one case that needs it:
-- when a runner's capacity backstop refuses after routing said yes,
-- `run-executor.service.ts` deletes the run row, and no park was avoided after
-- all.
--
-- Reads zero until a second runner exists (#102/#103 are blocked on the
-- vendor), because with one runner there is nowhere for work to move. That is
-- why it is built now rather than then: a metric that reads zero for a true
-- reason is what has to be in place BEFORE the thing it measures arrives, or
-- the before-and-after has no before. Zero is distinguishable from "not
-- measured" on the read side, which is `metrics.service.ts`'s standing rule.

CREATE TABLE "avoided_parks" (
  -- No DEFAULT gen_random_uuid(). Ids in this schema are application-generated
  -- by Prisma's driver adapter before the INSERT is sent; a database-side
  -- default is drift `migrate diff` will propose dropping. See prisma/README.md
  -- and #134, which removed eighteen of them.
  "id"                    UUID PRIMARY KEY,

  -- One dispatch decision produces one run and at most one avoided park, so a
  -- second row against the same run would double-count a single event. Enforced
  -- here rather than by the writer, because the writer is a retryable tick.
  "run_id"                UUID NOT NULL,

  -- When ROUTING decided. Not when the run started and not when it ended: the
  -- event is instantaneous, which is the whole difference between this table
  -- and `dead_intervals`. There is no second timestamp because there is no
  -- second end to record.
  "occurred_at"           TIMESTAMPTZ NOT NULL,

  -- Half of the operator's sentence - work moved OFF one runner and ONTO this
  -- one. Denormalized rather than joined through `runs`: the count groups by
  -- runner and the join buys nothing.
  "chosen_runner_key"     TEXT NOT NULL,

  -- The other half. Never empty: the row exists only because at least one
  -- capable runner was spent. Plural because more than one can be, and still
  -- ONE row - two spent runners and a third that took the work is one avoided
  -- park, and counting rows has to equal counting events.
  --
  -- "Capable" means what routing means by it: met every declared need and
  -- served the requested tier. A runner rejected for its tier was never an
  -- alternative this work order lost, and counting it as one would inflate the
  -- very number #105 is judged by.
  "exhausted_runner_keys" TEXT[],

  -- The soonest any of them said its window rolls. NULL only if none could date
  -- it, which routing does not in fact produce - it treats only a DATED block
  -- as exhaustion.
  --
  -- Recorded to EXPLAIN the count, never to subtract from anything.
  -- `resumes_at - occurred_at` is the length of the park that did not happen: a
  -- counterfactual, not a measurement. It is stored anyway because a bare
  -- integer is not actionable, and "work moved off claude-code-local while it
  -- was rate-limited until 14:20" names something an operator can go and check.
  "resumes_at"            TIMESTAMPTZ,

  -- One line per exhausted runner naming the observation its exhaustion rested
  -- on, verbatim from the decision. #64's standard applied to this record: a
  -- reviewer should be able to reconstruct why the row exists without reading
  -- routing code.
  "basis"                 TEXT[],

  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per run, so the count cannot double.
CREATE UNIQUE INDEX "avoided_parks_run_id_key" ON "avoided_parks" ("run_id");

-- The count's window scan, which is the only read this table has.
CREATE INDEX "avoided_parks_occurred_at_idx" ON "avoided_parks" ("occurred_at");

-- Cascade, matching `dead_intervals`: the record is a fact ABOUT a run and
-- means nothing without it. It also does real work here - the executor deletes
-- the run row when a runner's own capacity backstop refuses after routing said
-- yes, and in that case the work was re-queued and no park was avoided. The
-- claim retracts itself without anybody remembering to.
ALTER TABLE "avoided_parks"
  ADD CONSTRAINT "avoided_parks_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "runs" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
