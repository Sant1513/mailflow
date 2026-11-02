-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "rsvp" JSONB;

-- CreateTable
CREATE TABLE "RsvpResponse" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "emailJobId" TEXT,
    "recordId" TEXT,
    "email" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "note" TEXT,
    "changes" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "userAgent" TEXT,
    "respondedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RsvpResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RsvpResponse_campaignId_answer_idx" ON "RsvpResponse"("campaignId", "answer");

-- CreateIndex
CREATE UNIQUE INDEX "RsvpResponse_campaignId_email_key" ON "RsvpResponse"("campaignId", "email");

-- AddForeignKey
ALTER TABLE "RsvpResponse" ADD CONSTRAINT "RsvpResponse_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

