-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "recruiterBlastId" TEXT;

-- AlterTable
ALTER TABLE "RecruiterBlastRecipient" ADD COLUMN     "repliedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RecruiterBlastGroup" ADD COLUMN     "gmailThreadId" TEXT,
ADD COLUMN     "messageIdHeader" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_recruiterBlastId_idx" ON "Conversation"("recruiterBlastId");

-- CreateIndex
CREATE INDEX "RecruiterBlastGroup_messageIdHeader_idx" ON "RecruiterBlastGroup"("messageIdHeader");

