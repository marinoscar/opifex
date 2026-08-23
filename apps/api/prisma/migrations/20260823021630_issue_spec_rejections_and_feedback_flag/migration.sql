-- AlterTable
ALTER TABLE "repositories" ADD COLUMN     "spec_feedback_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "issue_spec_rejections" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "issue_number" INTEGER NOT NULL,
    "body_digest" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "commented_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "comment_url" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "issue_spec_rejections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "issue_spec_rejections_repository_id_issue_number_key" ON "issue_spec_rejections"("repository_id", "issue_number");

-- AddForeignKey
ALTER TABLE "issue_spec_rejections" ADD CONSTRAINT "issue_spec_rejections_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
