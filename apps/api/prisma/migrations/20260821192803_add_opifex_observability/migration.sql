-- CreateEnum
CREATE TYPE "RunnerInvocationModel" AS ENUM ('process', 'http_api', 'hosted_job');

-- CreateEnum
CREATE TYPE "RunnerExecutionLocus" AS ENUM ('own_infrastructure', 'vendor_cloud');

-- CreateEnum
CREATE TYPE "RunnerStreamingFidelity" AS ENUM ('full', 'partial', 'none');

-- CreateEnum
CREATE TYPE "RunnerSignalQuality" AS ENUM ('structured', 'heuristic', 'none');

-- CreateEnum
CREATE TYPE "RunnerStabilityTier" AS ENUM ('experimental', 'beta', 'stable');

-- CreateEnum
CREATE TYPE "RunEventType" AS ENUM ('run.started', 'run.heartbeat', 'run.progress', 'run.blocked', 'run.completed', 'run.failed');

-- CreateEnum
CREATE TYPE "RunEventSource" AS ENUM ('runner', 'git', 'control-plane');

-- CreateEnum
CREATE TYPE "EscalationKind" AS ENUM ('run_stalled', 'run_looping', 'run_failed', 'quarantined', 'budget_exceeded', 'system');

-- CreateEnum
CREATE TYPE "EscalationStatus" AS ENUM ('raised', 'dispatched', 'delivered', 'failed', 'acknowledged', 'resolved');

-- CreateTable
CREATE TABLE "runners" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "runners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runner_capabilities" (
    "id" UUID NOT NULL,
    "runner_id" UUID NOT NULL,
    "schema_version" TEXT NOT NULL,
    "invocation_model" "RunnerInvocationModel" NOT NULL,
    "execution_locus" "RunnerExecutionLocus" NOT NULL,
    "streaming_fidelity" "RunnerStreamingFidelity" NOT NULL,
    "rate_limit_signal" "RunnerSignalQuality" NOT NULL,
    "stability_tier" "RunnerStabilityTier" NOT NULL,
    "reports_cost" BOOLEAN NOT NULL DEFAULT false,
    "resumable" BOOLEAN NOT NULL DEFAULT false,
    "max_concurrency" INTEGER NOT NULL DEFAULT 1,
    "branch_patterns" TEXT[],
    "manifest" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "runner_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_events" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "type" "RunEventType" NOT NULL,
    "source" "RunEventSource" NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary" TEXT NOT NULL,
    "tool_signature" TEXT,
    "blocked_reason" TEXT,
    "blocked_until" TIMESTAMPTZ,
    "cost_usd" DECIMAL(10,4),
    "tokens_input" INTEGER,
    "tokens_output" INTEGER,
    "trace_id" TEXT,
    "span_id" TEXT,
    "payload" JSONB,

    CONSTRAINT "run_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalations" (
    "id" UUID NOT NULL,
    "run_id" UUID,
    "kind" "EscalationKind" NOT NULL,
    "status" "EscalationStatus" NOT NULL DEFAULT 'raised',
    "summary" TEXT NOT NULL,
    "detail" TEXT,
    "transport" TEXT,
    "receipt_id" TEXT,
    "failure_reason" TEXT,
    "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
    "raised_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "acknowledged_at" TIMESTAMPTZ,
    "acknowledged_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "escalations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "runners_key_key" ON "runners"("key");

-- CreateIndex
CREATE INDEX "runners_enabled_idx" ON "runners"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "runner_capabilities_runner_id_key" ON "runner_capabilities"("runner_id");

-- CreateIndex
CREATE INDEX "run_events_run_id_occurred_at_idx" ON "run_events"("run_id", "occurred_at");

-- CreateIndex
CREATE INDEX "run_events_occurred_at_idx" ON "run_events"("occurred_at");

-- CreateIndex
CREATE INDEX "run_events_run_id_tool_signature_idx" ON "run_events"("run_id", "tool_signature");

-- CreateIndex
CREATE INDEX "run_events_type_occurred_at_idx" ON "run_events"("type", "occurred_at");

-- CreateIndex
CREATE INDEX "escalations_run_id_idx" ON "escalations"("run_id");

-- CreateIndex
CREATE INDEX "escalations_status_raised_at_idx" ON "escalations"("status", "raised_at");

-- CreateIndex
CREATE INDEX "escalations_status_delivery_attempts_idx" ON "escalations"("status", "delivery_attempts");

-- CreateIndex
CREATE INDEX "runs_runner_key_status_idx" ON "runs"("runner_key", "status");

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_runner_key_fkey" FOREIGN KEY ("runner_key") REFERENCES "runners"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runner_capabilities" ADD CONSTRAINT "runner_capabilities_runner_id_fkey" FOREIGN KEY ("runner_id") REFERENCES "runners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_acknowledged_by_id_fkey" FOREIGN KEY ("acknowledged_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
