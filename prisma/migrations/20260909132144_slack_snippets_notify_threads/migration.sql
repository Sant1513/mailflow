-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "notifyEmailAccountId" TEXT,
ADD COLUMN     "notifyEmailMessageId" TEXT,
ADD COLUMN     "notifyEmailThreadId" TEXT,
ADD COLUMN     "notifySlackChannelId" TEXT,
ADD COLUMN     "notifySlackThreadTs" TEXT;

-- AlterTable
ALTER TABLE "FollowUp" ADD COLUMN     "remindedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "slackUserId" TEXT;

-- CreateTable
CREATE TABLE "IntegrationSettings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "slackChannelId" TEXT,
    "slackNotifyAssignments" BOOLEAN NOT NULL DEFAULT true,
    "slackNotifyResolutions" BOOLEAN NOT NULL DEFAULT true,
    "slackNotifyFollowUps" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplySnippet" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplySnippet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationSettings_organizationId_key" ON "IntegrationSettings"("organizationId");

-- CreateIndex
CREATE INDEX "ReplySnippet_workspaceId_idx" ON "ReplySnippet"("workspaceId");

-- AddForeignKey
ALTER TABLE "IntegrationSettings" ADD CONSTRAINT "IntegrationSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
