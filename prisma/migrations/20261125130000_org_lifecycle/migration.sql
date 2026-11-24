-- Organisation lifecycle (additive): enable / disable, seat limit, validity with grace, renewal reminders and a payment record.
-- Every existing organisation stays ACTIVE with no expiry and no seat limit, so nothing changes for anyone until a Super Admin sets one.
ALTER TABLE "OrgUnit" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "OrgUnit" ADD COLUMN "seatLimit" INTEGER;
ALTER TABLE "OrgUnit" ADD COLUMN "validUntil" TIMESTAMP(3);
ALTER TABLE "OrgUnit" ADD COLUMN "graceDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrgUnit" ADD COLUMN "lastReminderDays" INTEGER;
ALTER TABLE "OrgUnit" ADD COLUMN "billingNote" TEXT;

CREATE TABLE "OrgPayment" (
    "id" TEXT NOT NULL,
    "orgUnitId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'EXTEND',
    "amountMinor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "reference" TEXT,
    "note" TEXT,
    "days" INTEGER,
    "previousValidUntil" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrgPayment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrgPayment_orgUnitId_createdAt_idx" ON "OrgPayment"("orgUnitId", "createdAt");
ALTER TABLE "OrgPayment" ADD CONSTRAINT "OrgPayment_orgUnitId_fkey" FOREIGN KEY ("orgUnitId") REFERENCES "OrgUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
