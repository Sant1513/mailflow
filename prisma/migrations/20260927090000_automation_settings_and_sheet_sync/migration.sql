-- Additive only: two new columns, no existing data changed.
ALTER TABLE "IntegrationSettings" ADD COLUMN "settings" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "Dataset" ADD COLUMN "sheetSync" JSONB;
