-- CreateTable
CREATE TABLE "SystemState" (
    "id" TEXT NOT NULL DEFAULT 'main',
    "activeServer" TEXT NOT NULL DEFAULT 'cloud',
    "switchTo" TEXT,
    "switchStartedAt" TIMESTAMP(3),
    "switchRequestedBy" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastLaptopSeenAt" TIMESTAMP(3),
    "laptopUrl" TEXT,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemState_pkey" PRIMARY KEY ("id")
);

