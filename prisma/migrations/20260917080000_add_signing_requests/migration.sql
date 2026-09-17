-- CreateEnum
CREATE TYPE "SigningRequestStatus" AS ENUM ('DRAFT', 'SENT', 'VIEWED', 'SIGNED', 'EXPIRED', 'VOIDED');

-- CreateTable
CREATE TABLE "SigningRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "fieldValues" JSONB NOT NULL DEFAULT '{}',
    "ccEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "token" TEXT NOT NULL,
    "status" "SigningRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "expiresAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "signatureImage" TEXT,
    "signedPdfData" TEXT,
    "signerIp" TEXT,
    "signerAgent" TEXT,
    "sentById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SigningRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SigningRequest_token_key" ON "SigningRequest"("token");

-- CreateIndex
CREATE INDEX "SigningRequest_workspaceId_idx" ON "SigningRequest"("workspaceId");

-- CreateIndex
CREATE INDEX "SigningRequest_token_idx" ON "SigningRequest"("token");

-- AddForeignKey
ALTER TABLE "SigningRequest" ADD CONSTRAINT "SigningRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SigningRequest" ADD CONSTRAINT "SigningRequest_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
