-- CreateTable
CREATE TABLE "RecruiterBlast" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'BCC',
    "toAddress" TEXT,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "plainText" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'text',
    "includeSignature" BOOLEAN NOT NULL DEFAULT true,
    "fromName" TEXT,
    "replyTo" TEXT,
    "accountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accountLimits" JSONB NOT NULL DEFAULT '{}',
    "video" JSONB,
    "attachmentDocumentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "groupSize" INTEGER NOT NULL DEFAULT 250,
    "gapSeconds" INTEGER NOT NULL DEFAULT 60,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "note" TEXT,
    "copiedFromId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruiterBlast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruiterBlastRecipient" (
    "id" TEXT NOT NULL,
    "blastId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "groupId" TEXT,
    "sentAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "openCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RecruiterBlastRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruiterBlastGroup" (
    "id" TEXT NOT NULL,
    "blastId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "recipientCount" INTEGER NOT NULL,
    "accountId" TEXT,
    "fromEmail" TEXT,
    "gmailMessageId" TEXT,
    "errorCode" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "firstOpenedAt" TIMESTAMP(3),
    "lastOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecruiterBlastGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecruiterBlast_workspaceId_createdAt_idx" ON "RecruiterBlast"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "RecruiterBlast_status_idx" ON "RecruiterBlast"("status");

-- CreateIndex
CREATE INDEX "RecruiterBlastRecipient_blastId_status_idx" ON "RecruiterBlastRecipient"("blastId", "status");

-- CreateIndex
CREATE INDEX "RecruiterBlastRecipient_groupId_idx" ON "RecruiterBlastRecipient"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "RecruiterBlastRecipient_blastId_email_key" ON "RecruiterBlastRecipient"("blastId", "email");

-- CreateIndex
CREATE INDEX "RecruiterBlastGroup_accountId_status_sentAt_idx" ON "RecruiterBlastGroup"("accountId", "status", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecruiterBlastGroup_blastId_seq_key" ON "RecruiterBlastGroup"("blastId", "seq");

-- AddForeignKey
ALTER TABLE "RecruiterBlastRecipient" ADD CONSTRAINT "RecruiterBlastRecipient_blastId_fkey" FOREIGN KEY ("blastId") REFERENCES "RecruiterBlast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruiterBlastRecipient" ADD CONSTRAINT "RecruiterBlastRecipient_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "RecruiterBlastGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruiterBlastGroup" ADD CONSTRAINT "RecruiterBlastGroup_blastId_fkey" FOREIGN KEY ("blastId") REFERENCES "RecruiterBlast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

