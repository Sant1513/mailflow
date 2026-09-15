-- EmailTrackingEvent: stores open and click events for campaign emails.
CREATE TABLE "EmailTrackingEvent" (
    "id"         TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "emailJobId" TEXT NOT NULL,
    "email"      TEXT NOT NULL,
    "type"       TEXT NOT NULL,
    "url"        TEXT,
    "ip"         TEXT,
    "userAgent"  TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailTrackingEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailTrackingEvent_campaignId_idx" ON "EmailTrackingEvent"("campaignId");
CREATE INDEX "EmailTrackingEvent_emailJobId_idx" ON "EmailTrackingEvent"("emailJobId");
CREATE INDEX "EmailTrackingEvent_email_idx"      ON "EmailTrackingEvent"("email");

ALTER TABLE "EmailTrackingEvent"
    ADD CONSTRAINT "EmailTrackingEvent_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmailTrackingEvent"
    ADD CONSTRAINT "EmailTrackingEvent_emailJobId_fkey"
    FOREIGN KEY ("emailJobId") REFERENCES "EmailJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- EmailSuppression: unsubscribe / bounce suppression list per workspace.
CREATE TABLE "EmailSuppression" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email"       TEXT NOT NULL,
    "reason"      TEXT NOT NULL DEFAULT 'UNSUBSCRIBED',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailSuppression_workspaceId_email_key" ON "EmailSuppression"("workspaceId", "email");
CREATE INDEX        "EmailSuppression_workspaceId_idx"       ON "EmailSuppression"("workspaceId");

ALTER TABLE "EmailSuppression"
    ADD CONSTRAINT "EmailSuppression_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
