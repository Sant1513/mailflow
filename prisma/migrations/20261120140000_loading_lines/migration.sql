-- Smart loading screen (additive): the day's fresh lines, written by at most one AI call a day and shared by
-- every server. Existing rows keep NULL and behave exactly as before.
ALTER TABLE "SystemState" ADD COLUMN "loadingLines" JSONB;
ALTER TABLE "SystemState" ADD COLUMN "loadingLinesTriedAt" TIMESTAMP(3);
