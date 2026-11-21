-- Recruiter repeat guard, round 2 (additive): Gmail aliases count as one person, manual Inbox replies count as
-- "emailed", a per-person cool-off ("do not contact until"), and a code for why a recruiter was skipped.
-- Nothing existing changes; the new columns start empty.

-- One key per person: lower case, and for Gmail the dots and any "+tag" are ignored (a.b@gmail.com, ab@gmail.com
-- and ab+news@gmail.com are the same inbox; googlemail.com is Gmail). Mirrors emailKey() in lib/recruiterSend/emailKey.ts.
CREATE OR REPLACE FUNCTION mailflow_email_key(e text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN split_part(lower(btrim(e)), '@', 2) IN ('gmail.com', 'googlemail.com')
      THEN replace(split_part(split_part(lower(btrim(e)), '@', 1), '+', 1), '.', '') || '@gmail.com'
    ELSE lower(btrim(e))
  END
$$;

ALTER TABLE "RecruiterBlastRecipient" ADD COLUMN "skipKind" TEXT;
ALTER TABLE "Contact" ADD COLUMN "doNotContactUntil" TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN "coolOffNote" TEXT;

-- Expression indexes (Prisma's schema cannot describe them, so they live only here): "when was this person last emailed?"
CREATE INDEX "RecruiterBlastRecipient_emailKey_sentAt_idx" ON "RecruiterBlastRecipient" (mailflow_email_key("email"), "sentAt");
CREATE INDEX "EmailJob_toEmailKey_sentAt_idx" ON "EmailJob" (mailflow_email_key("toEmail"), "sentAt");
CREATE INDEX "ConversationMessage_recipientKey_sentAt_idx" ON "ConversationMessage" (mailflow_email_key("recipientEmail"), "sentAt");
CREATE INDEX "Contact_primaryEmailKey_idx" ON "Contact" (mailflow_email_key("primaryEmail"));
-- Cool-offs that are still running (a small, partial index).
CREATE INDEX "Contact_doNotContactUntil_idx" ON "Contact" ("doNotContactUntil") WHERE "doNotContactUntil" IS NOT NULL;
