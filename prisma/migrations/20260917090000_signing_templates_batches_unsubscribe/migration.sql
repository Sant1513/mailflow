-- AlterTable
ALTER TABLE "EmailJob" ADD COLUMN     "unsubscribeToken" TEXT;

-- AlterTable
ALTER TABLE "SigningRequest" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "reminderCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reminderSentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SigningTemplate" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "content" TEXT NOT NULL,
    "fieldDefs" JSONB NOT NULL DEFAULT '[]',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SigningTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SigningBatch" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "templateId" TEXT,
    "title" TEXT NOT NULL,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "signedCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SigningBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SigningTemplate_workspaceId_idx" ON "SigningTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "SigningBatch_workspaceId_idx" ON "SigningBatch"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailJob_unsubscribeToken_key" ON "EmailJob"("unsubscribeToken");

-- AddForeignKey
ALTER TABLE "SigningRequest" ADD CONSTRAINT "SigningRequest_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SigningBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SigningTemplate" ADD CONSTRAINT "SigningTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SigningTemplate" ADD CONSTRAINT "SigningTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SigningBatch" ADD CONSTRAINT "SigningBatch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SigningBatch" ADD CONSTRAINT "SigningBatch_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "SigningTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
