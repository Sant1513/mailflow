-- Additive only: one new column, empty for every existing campaign.
ALTER TABLE "Campaign" ADD COLUMN "fallbackAccountIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
