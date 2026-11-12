-- Bounce categories (additive). Every bounce / delivery report is sorted into a category with a
-- plain-English remark and the server's status code (lib/email/dsn.ts), and suppressions remember
-- which Recruiter Bulk Send they came from. Soft bounces (a full mailbox, delays) are kept in their
-- own table: a full mailbox suppresses only on its second notice within 30 days.
ALTER TABLE "EmailSuppression" ADD COLUMN "category" TEXT;
ALTER TABLE "EmailSuppression" ADD COLUMN "statusCode" TEXT;
ALTER TABLE "EmailSuppression" ADD COLUMN "remark" TEXT;
ALTER TABLE "EmailSuppression" ADD COLUMN "recruiterBlastId" TEXT;

CREATE INDEX "EmailSuppression_workspaceId_createdAt_idx" ON "EmailSuppression"("workspaceId", "createdAt");

CREATE TABLE "SoftBounce" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "statusCode" TEXT,
    "detail" TEXT,
    "gmailMessageId" TEXT,
    "campaignId" TEXT,
    "recruiterBlastId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SoftBounce_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SoftBounce_gmailMessageId_email_key" ON "SoftBounce"("gmailMessageId", "email");
CREATE INDEX "SoftBounce_organizationId_email_category_occurredAt_idx" ON "SoftBounce"("organizationId", "email", "category", "occurredAt");

-- Supabase's REST API stays locked out of new tables too (see 20261110140000_lock_supabase_api).
ALTER TABLE "SoftBounce" ENABLE ROW LEVEL SECURITY;
