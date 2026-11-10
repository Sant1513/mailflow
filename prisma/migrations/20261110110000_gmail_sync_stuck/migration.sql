-- Gmail sync (additive): since when a mailbox's sync has been held on one message that keeps
-- failing in a way that may pass; after 6 hours that message is skipped (lib/gmail/sync.ts).
ALTER TABLE "EmailProviderAccount" ADD COLUMN "syncStuckSince" TIMESTAMP(3);
