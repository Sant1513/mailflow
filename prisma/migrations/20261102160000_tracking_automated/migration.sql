-- AlterTable
ALTER TABLE "EmailTrackingEvent" ADD COLUMN     "automated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "automatedReason" TEXT;

-- CreateIndex
CREATE INDEX "EmailTrackingEvent_campaignId_type_automated_idx" ON "EmailTrackingEvent"("campaignId", "type", "automated");

