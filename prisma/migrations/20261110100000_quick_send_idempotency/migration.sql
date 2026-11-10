-- Quick Send idempotency (additive): the browser sends one key per compose; a retried or
-- double-submitted send finds the campaign it already created instead of emailing the list twice.
ALTER TABLE "Campaign" ADD COLUMN "clientRequestId" TEXT;
CREATE UNIQUE INDEX "Campaign_clientRequestId_key" ON "Campaign"("clientRequestId");
