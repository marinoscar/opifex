-- Quota windows (#231), so VISION §10's metric 6 has the half of itself that
-- can actually be observed.
--
-- WHAT THIS DOES NOT DO, first, because the issue asks for more than is
-- honestly available. Metric 6 is quota BURN: consumption over window
-- capacity. This table stores no capacity and computes no fraction, and both
-- ends of that ratio are the reason.
--
--   * The denominator does not exist. No vendor API publishes the
--     subscription's window limit - #102 established there is no
--     non-interactive cloud API at all - and `runner-capability.schema.json`
--     has no field for one. An operator-declared ceiling would be a guess
--     sitting in a denominator, and a metric whose denominator is invented
--     misleads more reliably than a missing one.
--   * The numerator is incomplete, and unboundedly so. VISION §11 says the
--     subscription is SHARED: automated runs compete with the operator's own
--     interactive use, which burns the same window and leaves no run_events
--     row. So even a perfect capacity would be divided into a numerator
--     missing an unobservable share. This also disposes of the tempting
--     self-calibration - "consumption just before a limit fired is a lower
--     bound on capacity" - because that measures capacity minus that window's
--     interactive use, a different number every window, moving for a reason
--     the metric cannot see.
--
-- `cockpit/metrics.service.ts` therefore keeps returning NOT_MEASURED for
-- `quotaBurn`, and its stated reason gets sharper rather than disappearing:
-- consumption IS now recorded against real windows; capacity is not
-- obtainable and the numerator is co-tenanted.
--
-- WHAT THIS DOES. `claude-code-local` emits `rate_limit_event` lines carrying
-- `resetsAt` (unix seconds) and a `rateLimitType` label on healthy turns as
-- well as refused ones, and `stream-json-mapper.ts` was dropping every healthy
-- one ("rate limit status is allowed"). Those lines are the only place the
-- window boundary is observable BEFORE the wall is hit. Recording them gives:
--
--   * #113 the reset instant it needs to schedule against, without waiting for
--     a park to reveal it;
--   * #86 a quota screen with a dated window, a vendor-reported pressure and
--     Opifex's own consumption through it, instead of "not measured";
--   * #89's supervisor gate a `warning` reading, which arrives BEFORE a worker
--     is parked rather than after.
--
-- WHY NO CONSUMPTION COLUMNS. Consumption is already recorded, on
-- `run_events.cost_usd` and `tokens_*`. A copy here would be a second source
-- of truth for the same quantity, which is the failure
-- `dispatch/dispatch-policy.ts` names for the position signal: "standing up a
-- second one here would guarantee the two disagree". `QuotaService` sums the
-- events between a window's start and its reset instead, so the total can only
-- ever be as right as the events are - and an event ingested late corrects the
-- window rather than being lost.

-- An ORDINAL, not a fraction. `warning` is genuinely before `exhausted`, and
-- ordering them is the most the vendor's own words support. `unknown` is a
-- value rather than a NULL for the reason `run_events.source` has no default:
-- an unrecognized status still carries a usable reset time, and it must be
-- recorded as something somebody chose.
CREATE TYPE "QuotaPressure" AS ENUM ('unknown', 'allowed', 'warning', 'exhausted');

CREATE TABLE "quota_windows" (
  -- No DEFAULT. Prisma 7 generates ids client-side; see prisma/README.md,
  -- where a database-side default is drift from the moment it is written.
  "id"                UUID PRIMARY KEY,

  -- Per RUNNER, which is the first of #231's two open questions. VISION §11
  -- describes one operator with one budget, but a fleet with a cloud runner
  -- and a local one genuinely has two windows, and only the runner that
  -- observed a window can say whose it was. Aggregating them here would make
  -- the two-subscription case unrepresentable; the read model can always sum
  -- across runners, and cannot un-sum.
  "runner_key"        TEXT NOT NULL,

  -- The vendor's own label, verbatim: 'five_hour', 'weekly'. TEXT rather than
  -- an enum because the set belongs to the vendor - a closed type would reject
  -- the first label a CLI release adds, discarding the reset time along with
  -- it. 'unknown' rather than NULL so the unique key below works: Postgres
  -- treats NULLs as distinct, so a nullable column there would insert a fresh
  -- row on every observation instead of finding the existing one.
  "kind"              TEXT NOT NULL,

  -- The window's identity: when the vendor said it rolls.
  "resets_at"         TIMESTAMPTZ NOT NULL,

  -- Latest and worst, kept apart. `pressure` is what routing and the
  -- supervisor gate want (how things stand now); `peak_pressure` is what a
  -- human reviewing the day wants (whether this window ever hit the wall),
  -- which `pressure` forgets the moment the vendor says 'allowed' again.
  "pressure"          "QuotaPressure" NOT NULL,
  "peak_pressure"     "QuotaPressure" NOT NULL,

  -- `first_observed_at` is the fallback window START when the label names no
  -- length. The read model reports which of the two it used, because a start
  -- derived from a five-hour label and one that is merely the first time we
  -- looked are different claims about the same field.
  "first_observed_at" TIMESTAMPTZ NOT NULL,
  "last_observed_at"  TIMESTAMPTZ NOT NULL,

  -- How many lines carried this window. NOT a consumption measure - the CLI
  -- emits these on its own cadence - but it separates a window glimpsed once
  -- from one watched throughout, which is how far the row can be trusted to
  -- cover its own span.
  "observations"      INTEGER NOT NULL DEFAULT 1,

  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- No default: Prisma's @updatedAt always supplies it, matching every other
  -- table in this schema.
  "updated_at"        TIMESTAMPTZ NOT NULL
);

-- The upsert key. One row per window per runner, however many lines mentioned
-- it - which is what makes ingestion idempotent without the runner having to
-- remember what it already reported.
CREATE UNIQUE INDEX "quota_windows_runner_key_kind_resets_at_key"
  ON "quota_windows" ("runner_key", "kind", "resets_at");

-- "The current window for this runner": the newest reset instant still ahead
-- of now. Every read starts here.
CREATE INDEX "quota_windows_runner_key_resets_at_idx"
  ON "quota_windows" ("runner_key", "resets_at");

-- Onto `runners.key` rather than its uuid, matching `runs.runner_key`: the key
-- is what the `Runner:` commit trailer records, so the trailer and the
-- database agree by construction. Restrict for the same reason `runs` uses it
-- - a window is evidence about a subscription and should not vanish because a
-- row was deleted. Registration converges rather than deleting (#162), so
-- nothing in normal operation hits this.
ALTER TABLE "quota_windows"
  ADD CONSTRAINT "quota_windows_runner_key_fkey"
  FOREIGN KEY ("runner_key") REFERENCES "runners" ("key")
  ON DELETE RESTRICT ON UPDATE CASCADE;
