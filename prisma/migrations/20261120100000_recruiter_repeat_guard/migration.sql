-- Recruiter repeat guard (additive): a recruiter emailed in the last N days is skipped unless the admin
-- chooses to send again. Existing sends keep working; drafts get the default 10-day window.
ALTER TABLE "RecruiterBlast" ADD COLUMN "repeatWindowDays" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "RecruiterBlastRecipient" ADD COLUMN "repeatOk" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "RecruiterBlastRecipient_email_sentAt_idx" ON "RecruiterBlastRecipient"("email", "sentAt");
-- Campaign / Quick Send emails are matched case-insensitively on the address (EmailJob.toEmail is stored as typed).
-- An expression index: Prisma's schema cannot describe it, so it lives only in this migration.
CREATE INDEX "EmailJob_toEmail_lower_sentAt_idx" ON "EmailJob" (lower("toEmail"), "sentAt");
