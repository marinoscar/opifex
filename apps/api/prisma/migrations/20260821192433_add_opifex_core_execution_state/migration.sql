-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('pending', 'queued', 'held', 'dispatched', 'succeeded', 'failed', 'quarantined', 'superseded', 'cancelled');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('running', 'succeeded', 'stalled', 'blocked', 'failed', 'quarantined');

-- CreateEnum
CREATE TYPE "RunAttemptOutcome" AS ENUM ('running', 'succeeded', 'failed', 'killed', 'blocked');

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repositories" (
    "id" UUID NOT NULL,
    "project_id" UUID,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL DEFAULT 'main',
    "observe_enabled" BOOLEAN NOT NULL DEFAULT true,
    "dispatch_enabled" BOOLEAN NOT NULL DEFAULT false,
    "budget_ceiling_usd" DECIMAL(10,4),
    "wall_clock_timeout_minutes" INTEGER,
    "path_constraints" TEXT[],
    "last_observed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_orders" (
    "id" UUID NOT NULL,
    "identity" TEXT NOT NULL,
    "repository_id" UUID NOT NULL,
    "issue_number" INTEGER NOT NULL,
    "base_commit" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "branch" TEXT NOT NULL,
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'pending',
    "task_spec" TEXT NOT NULL,
    "acceptance_criteria" TEXT[],
    "path_constraints" TEXT[],
    "budget_ceiling_usd" DECIMAL(10,4),
    "wall_clock_timeout_minutes" INTEGER,
    "decision_refs" TEXT[],
    "authorization_comment_url" TEXT,
    "hold_reason" TEXT,
    "queued_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" UUID NOT NULL,
    "work_order_id" UUID NOT NULL,
    "runner_key" TEXT NOT NULL,
    "runner_version" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,
    "last_event_at" TIMESTAMPTZ,
    "resumes_at" TIMESTAMPTZ,
    "attention_reason" TEXT,
    "stop_reason" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(10,4),
    "tokens_input" INTEGER,
    "tokens_output" INTEGER,
    "pull_request_url" TEXT,
    "pull_request_number" INTEGER,
    "head_commit" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_attempts" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "outcome" "RunAttemptOutcome" NOT NULL DEFAULT 'running',
    "runner_run_id" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,
    "stop_reason" TEXT,
    "blocked_until" TIMESTAMPTZ,
    "cost_usd" DECIMAL(10,4),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "run_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- CreateIndex
CREATE INDEX "repositories_project_id_idx" ON "repositories"("project_id");

-- CreateIndex
CREATE INDEX "repositories_observe_enabled_last_observed_at_idx" ON "repositories"("observe_enabled", "last_observed_at");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_owner_name_key" ON "repositories"("owner", "name");

-- CreateIndex
CREATE UNIQUE INDEX "work_orders_identity_key" ON "work_orders"("identity");

-- CreateIndex
CREATE UNIQUE INDEX "work_orders_branch_key" ON "work_orders"("branch");

-- CreateIndex
CREATE INDEX "work_orders_repository_id_issue_number_idx" ON "work_orders"("repository_id", "issue_number");

-- CreateIndex
CREATE INDEX "work_orders_status_queued_at_idx" ON "work_orders"("status", "queued_at");

-- CreateIndex
CREATE UNIQUE INDEX "work_orders_repository_id_issue_number_base_commit_attempt_key" ON "work_orders"("repository_id", "issue_number", "base_commit", "attempt");

-- CreateIndex
CREATE INDEX "runs_work_order_id_idx" ON "runs"("work_order_id");

-- CreateIndex
CREATE INDEX "runs_status_last_event_at_idx" ON "runs"("status", "last_event_at");

-- CreateIndex
CREATE INDEX "runs_resumes_at_idx" ON "runs"("resumes_at");

-- CreateIndex
CREATE INDEX "runs_started_at_idx" ON "runs"("started_at");

-- CreateIndex
CREATE INDEX "run_attempts_run_id_idx" ON "run_attempts"("run_id");

-- CreateIndex
CREATE INDEX "run_attempts_outcome_idx" ON "run_attempts"("outcome");

-- CreateIndex
CREATE UNIQUE INDEX "run_attempts_run_id_number_key" ON "run_attempts"("run_id", "number");

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_attempts" ADD CONSTRAINT "run_attempts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
