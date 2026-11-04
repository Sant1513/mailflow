-- Profile photos of people we email (additive).
ALTER TABLE "EmailProviderAccount" ADD COLUMN "photosSyncedAt" TIMESTAMP(3);

CREATE TABLE "ProfilePhoto" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "accountId" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProfilePhoto_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProfilePhoto_organizationId_email_key" ON "ProfilePhoto"("organizationId", "email");
CREATE INDEX "ProfilePhoto_accountId_idx" ON "ProfilePhoto"("accountId");
