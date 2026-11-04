-- Recruiter Bulk Send: CC addresses copied on every email (additive).
ALTER TABLE "RecruiterBlast" ADD COLUMN "ccAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[];
