-- CreateTable
CREATE TABLE "InboxShare" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "granteeId" TEXT,
    "level" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboxShare_granteeId_idx" ON "InboxShare"("granteeId");

-- CreateIndex
CREATE INDEX "InboxShare_organizationId_idx" ON "InboxShare"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "InboxShare_ownerId_granteeId_key" ON "InboxShare"("ownerId", "granteeId");

-- AddForeignKey
ALTER TABLE "InboxShare" ADD CONSTRAINT "InboxShare_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxShare" ADD CONSTRAINT "InboxShare_granteeId_fkey" FOREIGN KEY ("granteeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

