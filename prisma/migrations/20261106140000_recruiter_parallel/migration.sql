-- Recruiter Bulk Send: all chosen mailboxes send together, each with its own pause (additive).
ALTER TABLE "RecruiterBlast" ADD COLUMN "sendOrder" TEXT NOT NULL DEFAULT 'PARALLEL';
-- Sends already under way finish the way they started (one mailbox after another).
UPDATE "RecruiterBlast" SET "sendOrder" = 'SEQUENTIAL' WHERE "status" IN ('SENDING', 'PAUSED', 'SCHEDULED');
-- The mailbox each message is planned to go from (set at start; moved if that mailbox can't send).
ALTER TABLE "RecruiterBlastGroup" ADD COLUMN "plannedAccountId" TEXT;
