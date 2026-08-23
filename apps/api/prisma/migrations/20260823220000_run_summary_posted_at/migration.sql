-- Run summaries (#67): when the VISION §5 summary was posted to GitHub.
--
-- Nullable with no default and no backfill. Null means "still owed", which is
-- the sweep's query — and every run that concluded before this column existed
-- genuinely is owed one, so the honest starting state is the one the column
-- already has.
ALTER TABLE "runs" ADD COLUMN "summary_posted_at" TIMESTAMPTZ;

-- The sweep asks for concluded runs whose summary is still null.
CREATE INDEX "runs_summary_posted_at_status_idx" ON "runs" ("summary_posted_at", "status");
