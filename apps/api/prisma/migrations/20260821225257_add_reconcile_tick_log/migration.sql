-- CreateTable
CREATE TABLE "reconcile_ticks" (
    "id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "finished_at" TIMESTAMPTZ NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "repositories_observed" INTEGER NOT NULL,
    "actions_computed" INTEGER NOT NULL,
    "actions_executed" INTEGER NOT NULL DEFAULT 0,
    "all_from_cache" BOOLEAN NOT NULL,
    "rate_limit_remaining" INTEGER,
    "failures" JSONB NOT NULL,
    "projections" JSONB,
    "actions" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconcile_ticks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reconcile_ticks_started_at_idx" ON "reconcile_ticks"("started_at");

-- CreateIndex
CREATE INDEX "reconcile_ticks_outcome_started_at_idx" ON "reconcile_ticks"("outcome", "started_at");
