-- §22: expose sender display name, Reply-To and Cc/Bcc on campaigns.
-- The MIME builder and provider already supported these; only the campaign
-- layer had no way to configure them.
--
-- The From ADDRESS is deliberately NOT added: it stays pinned to the
-- connected mailbox so a campaign cannot spoof a sender (§28).
ALTER TABLE "Campaign" ADD COLUMN "fromName" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "replyTo" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "ccEmails" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Campaign" ADD COLUMN "bccEmails" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Stored per job so history keeps the exact Reply-To that was used (§89).
ALTER TABLE "EmailJob" ADD COLUMN "replyTo" TEXT;
