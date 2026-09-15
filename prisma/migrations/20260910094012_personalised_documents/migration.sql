-- CreateEnum
CREATE TYPE "DocumentLockMode" AS ENUM ('FLATTEN', 'LOCK_FILLED', 'EDITABLE');

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "campaignDocumentId" TEXT,
ADD COLUMN     "documentRef" TEXT,
ADD COLUMN     "fieldValues" JSONB,
ADD COLUMN     "generatedAt" TIMESTAMP(3),
ADD COLUMN     "sha256" TEXT;

-- CreateTable
CREATE TABLE "DocumentFile" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "pages" JSONB NOT NULL,
    "formFields" JSONB NOT NULL,
    "hasXfa" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "fileId" TEXT NOT NULL,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "fileNamePattern" TEXT NOT NULL,
    "lockMode" "DocumentLockMode" NOT NULL DEFAULT 'FLATTEN',
    "stampReference" BOOLEAN NOT NULL DEFAULT true,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignDocument" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "documentTemplateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "fileNamePattern" TEXT NOT NULL,
    "lockMode" "DocumentLockMode" NOT NULL,
    "stampReference" BOOLEAN NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentFile_organizationId_sha256_key" ON "DocumentFile"("organizationId", "sha256");

-- CreateIndex
CREATE INDEX "DocumentTemplate_workspaceId_idx" ON "DocumentTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "CampaignDocument_campaignId_idx" ON "CampaignDocument"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDocument_campaignId_documentTemplateId_key" ON "CampaignDocument"("campaignId", "documentTemplateId");

-- CreateIndex
CREATE INDEX "Attachment_emailJobId_idx" ON "Attachment"("emailJobId");

-- CreateIndex
CREATE INDEX "Attachment_campaignDocumentId_idx" ON "Attachment"("campaignDocumentId");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_campaignDocumentId_fkey" FOREIGN KEY ("campaignDocumentId") REFERENCES "CampaignDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "DocumentFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDocument" ADD CONSTRAINT "CampaignDocument_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDocument" ADD CONSTRAINT "CampaignDocument_documentTemplateId_fkey" FOREIGN KEY ("documentTemplateId") REFERENCES "DocumentTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDocument" ADD CONSTRAINT "CampaignDocument_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "DocumentFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
