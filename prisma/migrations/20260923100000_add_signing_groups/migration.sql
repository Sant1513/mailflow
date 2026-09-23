-- CreateEnum
CREATE TYPE "SigningOrder" AS ENUM ('SEQUENTIAL', 'PARALLEL');

-- CreateTable
CREATE TABLE "SigningGroup" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "batchId" TEXT,
    "signingOrder" "SigningOrder" NOT NULL DEFAULT 'SEQUENTIAL',
    "totalSigners" INTEGER NOT NULL,
    "signedCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "combinedPdfData" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SigningGroup_pkey" PRIMARY KEY ("id")
);

-- AddColumns to SigningRequest
ALTER TABLE "SigningRequest" ADD COLUMN "groupId" TEXT;
ALTER TABLE "SigningRequest" ADD COLUMN "signerOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SigningRequest" ADD COLUMN "signerRole" TEXT;
ALTER TABLE "SigningRequest" ADD COLUMN "assignedFields" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "SigningGroup_workspaceId_idx" ON "SigningGroup"("workspaceId");
CREATE INDEX "SigningGroup_batchId_idx" ON "SigningGroup"("batchId");
CREATE INDEX "SigningRequest_groupId_idx" ON "SigningRequest"("groupId");

-- AddForeignKey
ALTER TABLE "SigningGroup" ADD CONSTRAINT "SigningGroup_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SigningGroup" ADD CONSTRAINT "SigningGroup_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SigningBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SigningRequest" ADD CONSTRAINT "SigningRequest_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SigningGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
