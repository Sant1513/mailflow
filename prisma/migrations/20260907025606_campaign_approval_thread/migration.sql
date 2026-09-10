-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "approvalDecisionEmail" TEXT,
ADD COLUMN     "approvalRemarks" TEXT,
ADD COLUMN     "approvalRequestAccountId" TEXT,
ADD COLUMN     "approvalRequestEmail" TEXT,
ADD COLUMN     "approvalRequestMessageId" TEXT,
ADD COLUMN     "approvalRequestThreadId" TEXT,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3);
