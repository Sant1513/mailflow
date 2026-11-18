-- Recruiter Follow-up (additive): a follow-up is a RecruiterBlast that points at the send it
-- follows up. Existing sends keep parentBlastId NULL, round 1 and behave exactly as before.
ALTER TABLE "RecruiterBlast" ADD COLUMN "parentBlastId" TEXT;
ALTER TABLE "RecruiterBlast" ADD COLUMN "rootBlastId" TEXT;
ALTER TABLE "RecruiterBlast" ADD COLUMN "round" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "RecruiterBlast" ADD COLUMN "followUpAudience" TEXT;
ALTER TABLE "RecruiterBlast" ADD COLUMN "onMailboxDown" TEXT NOT NULL DEFAULT 'WAIT';
CREATE INDEX "RecruiterBlast_rootBlastId_idx" ON "RecruiterBlast"("rootBlastId");
CREATE INDEX "RecruiterBlast_parentBlastId_idx" ON "RecruiterBlast"("parentBlastId");
ALTER TABLE "RecruiterBlastRecipient" ADD COLUMN "sourceGroupId" TEXT;
ALTER TABLE "RecruiterBlastGroup" ADD COLUMN "inReplyToGroupId" TEXT;
