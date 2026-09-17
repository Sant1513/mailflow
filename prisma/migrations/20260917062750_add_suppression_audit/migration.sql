-- AlterTable
ALTER TABLE "EmailSuppression" ADD COLUMN     "addedByUserId" TEXT,
ADD COLUMN     "campaignId" TEXT,
ADD COLUMN     "detail" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'MANUAL';

-- AddForeignKey
ALTER TABLE "EmailSuppression" ADD CONSTRAINT "EmailSuppression_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSuppression" ADD CONSTRAINT "EmailSuppression_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
