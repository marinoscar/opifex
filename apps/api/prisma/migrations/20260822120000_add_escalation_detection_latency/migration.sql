-- AlterTable
ALTER TABLE "escalations" ADD COLUMN     "detect_latency_ms" INTEGER,
ADD COLUMN     "detection_source" "RunEventSource",
ADD COLUMN     "notify_latency_ms" INTEGER,
ADD COLUMN     "progress_stopped_at" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "escalations_detection_source_raised_at_idx" ON "escalations"("detection_source", "raised_at");
