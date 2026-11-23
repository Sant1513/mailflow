-- Follow-up type (additive): THREAD = reply in the original Gmail thread with the same subject (default, as before);
-- NEW = an individual new email with its own subject, not tied to the earlier thread or mailbox.
ALTER TABLE "RecruiterBlast" ADD COLUMN "followUpMode" TEXT NOT NULL DEFAULT 'THREAD';
ALTER TABLE "Campaign" ADD COLUMN "followUpMode" TEXT NOT NULL DEFAULT 'THREAD';
