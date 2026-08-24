-- Pull-request merge state (#215), so success metrics 3 and 5 can compute.
--
-- `closed` means closed WITHOUT merging. Keeping it distinct from `merged` is
-- the point: a PR closed without merging is not awaiting review, and folding
-- the two together would make first-pass acceptance look better than it is.
CREATE TYPE "PullRequestOutcome" AS ENUM ('merged', 'closed');

-- Nullable, no default, no backfill. Null means "still open, or not read yet",
-- which is exactly the sweep's query — and every run that finished before this
-- column existed genuinely has not been read.
ALTER TABLE "runs" ADD COLUMN "pull_request_state" "PullRequestOutcome";
ALTER TABLE "runs" ADD COLUMN "pull_request_merged_at" TIMESTAMPTZ;

-- The sweep asks for runs with a pull request and no settled state; metric 3
-- counts by this column.
CREATE INDEX "runs_pull_request_state_idx" ON "runs" ("pull_request_state");
