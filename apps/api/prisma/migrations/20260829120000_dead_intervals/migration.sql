-- Dead intervals (#232), so VISION §10's metric 2 - "hours parked or stalled"
-- - has durations to sum instead of only start instants.
--
-- What already existed was HALF an interval. `escalations.progress_stopped_at`
-- records when a run stopped making progress, and #59 measures from it to
-- delivery: that is metric 1, detection latency. Nothing recorded when the
-- non-progress ENDED, so metric 2 could only have been approximated from
-- currently-stalled runs - "dead time right now", which answers a different
-- question, and which `cockpit/metrics.service.ts` refuses in prose.
--
-- Stored rather than derived at query time, and the reason is correctness
-- rather than cost. The START of an interval is a JUDGEMENT: four minutes of
-- silence is a stall for a runner declaring `full` streaming fidelity (90s
-- threshold) and completely normal for one declaring `none` (90 minutes).
-- Re-deriving intervals from `run_events` later would re-judge history against
-- whatever the thresholds are THEN, so retuning one would silently rewrite
-- last week's dead time. A trend whose past moves when you turn a knob is not
-- a trend.
--
-- Parked time counts as dead time. VISION §10 defines the metric as "hours
-- parked or stalled" and the cockpit tile already renders that sentence;
-- VISION §1's origin story calls four parked hours "four hours dead"; and if
-- parked time were free, a factory that parked everything and shipped nothing
-- would score zero. `kind` keeps the two separable so the metric can always
-- say which half of a bad day was supervision and which was quota.

-- Two kinds rather than one flag: VISION §9 keeps its failure modes distinct,
-- and a stalled hour (supervision failed) and a parked hour (scheduling is
-- working) mean opposite things to the operator reading the sum.
CREATE TYPE "DeadIntervalKind" AS ENUM ('stalled', 'parked');

-- Three ends, not folded together. `resumed` time was recovered; `concluded`
-- time never was; `quarantined` time was handed to a human, and by VISION §8 a
-- run cannot clear its own quarantine, so the interval ends there and whatever
-- the quarantine costs afterwards is a separate question.
CREATE TYPE "DeadIntervalEnd" AS ENUM ('resumed', 'concluded', 'quarantined');

CREATE TABLE "dead_intervals" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id"     UUID NOT NULL,

  "kind"       "DeadIntervalKind" NOT NULL,

  -- When progress actually stopped, NOT when it was noticed. The same instant
  -- `escalations.progress_stopped_at` records - the two metrics share a start
  -- and fork at the end, which is exactly why they are separate rows.
  "started_at" TIMESTAMPTZ NOT NULL,

  -- NULL means still stalled or still parked. An open interval is COUNTED,
  -- clipped at the end of whatever window is asked about, because a factory
  -- that is dead right now must not read as a healthy zero. It is not a
  -- special case: every interval is clipped to the window, so an open one is
  -- simply one whose end is at or past the window's end.
  "ended_at"   TIMESTAMPTZ,
  -- NULL exactly when "ended_at" is NULL. Not a CHECK constraint: nothing else
  -- in this schema uses one, and a constraint Prisma cannot express would show
  -- up as permanent drift in `migrate diff`. The invariant is enforced by the
  -- single writer, `dead-time/dead-time.service.ts`, which is also the only
  -- thing that may open or close a row here.
  "ended_by"   "DeadIntervalEnd",

  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- No default: Prisma's @updatedAt always supplies it, and every other table
  -- in this schema is written the same way.
  "updated_at" TIMESTAMPTZ NOT NULL
);

-- The ledger's own write query: "the open interval for this run, if any".
CREATE INDEX "dead_intervals_run_id_ended_at_idx" ON "dead_intervals" ("run_id", "ended_at");

-- Metric 2's window scan. One row per stall or park rather than one per event,
-- which is what makes #232's "without scanning run_events" criterion true:
-- this table is smaller than the event table by the ratio of events to stalls.
CREATE INDEX "dead_intervals_started_at_idx" ON "dead_intervals" ("started_at");

-- Cascade: an interval is a fact ABOUT a run and means nothing without it,
-- matching run_events and run_attempts rather than the SetNull used where a
-- record has to outlive its pointer.
ALTER TABLE "dead_intervals"
  ADD CONSTRAINT "dead_intervals_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "runs" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
