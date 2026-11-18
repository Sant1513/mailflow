-- Quick Send follow-up (additive): a follow-up is a Campaign that points at the campaign it follows
-- up; its emails reply in the earlier email's Gmail thread. Existing campaigns keep NULL / round 1
-- and behave exactly as before.
ALTER TABLE "Campaign" ADD COLUMN "parentCampaignId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "rootCampaignId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "round" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Campaign" ADD COLUMN "followUpAudience" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "onMailboxDown" TEXT NOT NULL DEFAULT 'WAIT';
CREATE INDEX "Campaign_rootCampaignId_idx" ON "Campaign"("rootCampaignId");
ALTER TABLE "EmailJob" ADD COLUMN "replyThreadId" TEXT;
ALTER TABLE "EmailJob" ADD COLUMN "inReplyToJobId" TEXT;
