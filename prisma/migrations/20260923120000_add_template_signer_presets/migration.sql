-- AlterTable
ALTER TABLE "SigningTemplate" ADD COLUMN "signerPresets" JSONB NOT NULL DEFAULT '[]';
