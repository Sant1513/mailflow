-- AlterTable
ALTER TABLE "ConversationMessage" ADD COLUMN     "aiIntent" TEXT,
ADD COLUMN     "aiIntentConfidence" DOUBLE PRECISION,
ADD COLUMN     "aiIntentReason" TEXT;
