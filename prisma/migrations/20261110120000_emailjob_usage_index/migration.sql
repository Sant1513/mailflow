-- Daily limits and pacing (additive): every send checks what the mailbox sent in the last
-- 24 hours (lib/queue/drain.ts); without this index those queries scan every SENT job.
CREATE INDEX "EmailJob_emailProviderAccountId_status_sentAt_idx" ON "EmailJob"("emailProviderAccountId", "status", "sentAt");
