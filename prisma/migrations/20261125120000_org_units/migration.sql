-- Organisations (teams / business units) inside the company (additive). Every user belongs to one; a send is made "as" one
-- organisation and may use only that organisation's mailboxes. Existing people are placed by their sign-in domain, so the
-- Masai School and Neev Labs people start in separate organisations (a Super Admin then creates Operations, HR, Tech,
-- Curriculum… and moves people).

CREATE TABLE "OrgUnit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrgUnit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrgUnit_organizationId_name_key" ON "OrgUnit"("organizationId", "name");
CREATE INDEX "OrgUnit_organizationId_idx" ON "OrgUnit"("organizationId");
ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "User" ADD COLUMN "orgUnitId" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "orgUnitId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "orgUnitId" TEXT;
ALTER TABLE "RecruiterBlast" ADD COLUMN "orgUnitId" TEXT;
CREATE INDEX "User_orgUnitId_idx" ON "User"("orgUnitId");
CREATE INDEX "Workspace_orgUnitId_idx" ON "Workspace"("orgUnitId");
ALTER TABLE "User" ADD CONSTRAINT "User_orgUnitId_fkey" FOREIGN KEY ("orgUnitId") REFERENCES "OrgUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_orgUnitId_fkey" FOREIGN KEY ("orgUnitId") REFERENCES "OrgUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: one organisation per sign-in domain already in use, named for the brand where it is known.
INSERT INTO "OrgUnit" ("id", "organizationId", "name", "domains", "createdAt", "updatedAt")
SELECT 'ou' || substr(md5(u."organizationId" || ':' || split_part(u."email", '@', 2)), 1, 22),
       u."organizationId",
       CASE split_part(u."email", '@', 2) WHEN 'masaischool.com' THEN 'Masai School' WHEN 'neevlabs.ai' THEN 'Neev Labs' ELSE split_part(u."email", '@', 2) END,
       ARRAY[split_part(u."email", '@', 2)],
       now(), now()
FROM "User" u
GROUP BY u."organizationId", split_part(u."email", '@', 2);

UPDATE "User" u SET "orgUnitId" = ou."id"
FROM "OrgUnit" ou
WHERE ou."organizationId" = u."organizationId" AND ou."domains"[1] = split_part(u."email", '@', 2);

UPDATE "Workspace" w SET "orgUnitId" = u."orgUnitId" FROM "User" u WHERE w."ownerId" = u."id";
UPDATE "RecruiterBlast" b SET "orgUnitId" = u."orgUnitId" FROM "User" u WHERE b."createdById" = u."id";
UPDATE "Campaign" c SET "orgUnitId" = w."orgUnitId" FROM "Workspace" w WHERE c."workspaceId" = w."id";
