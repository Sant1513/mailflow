-- Recruiter Bulk Send: every pasted/uploaded column is kept, for {{Column}} personalisation (additive).
ALTER TABLE "RecruiterBlast" ADD COLUMN "columns" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "RecruiterBlast" ADD COLUMN "emailColumn" TEXT;
ALTER TABLE "RecruiterBlastRecipient" ADD COLUMN "data" JSONB;
