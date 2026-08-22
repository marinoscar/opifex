-- AlterTable
ALTER TABLE "run_events" ADD COLUMN     "external_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "run_events_run_id_external_id_key" ON "run_events"("run_id", "external_id");

