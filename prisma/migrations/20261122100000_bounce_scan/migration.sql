-- Bounce scan (additive): every connected mailbox is searched for delivery-failure notices on a schedule, so a bounce is never
-- missed because inbox sync does not run for that mailbox. The scan remembers how far it has read in each mailbox.
ALTER TABLE "EmailProviderAccount" ADD COLUMN "bounceScanAt" TIMESTAMP(3);
ALTER TABLE "EmailProviderAccount" ADD COLUMN "bounceScanError" TEXT;
ALTER TABLE "EmailProviderAccount" ADD COLUMN "bounceScanNotices" INTEGER NOT NULL DEFAULT 0;
