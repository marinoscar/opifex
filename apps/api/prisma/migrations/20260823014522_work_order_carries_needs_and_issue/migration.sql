-- AlterTable
ALTER TABLE "work_orders" ADD COLUMN     "issue_title" TEXT,
ADD COLUMN     "issue_url" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "needs" TEXT[] DEFAULT ARRAY[]::TEXT[];
