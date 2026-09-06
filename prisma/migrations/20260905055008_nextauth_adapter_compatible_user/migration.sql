-- Make User compatible with NextAuth's PrismaAdapter.
--
-- The adapter creates the User row itself and only supplies
-- email/name/image/emailVerified. Previously `image` and `emailVerified`
-- did not exist and `googleId` was NOT NULL, so adapter.createUser failed;
-- the app compensated by creating the User in the signIn callback, which
-- left it with no linked Account row and made every real sign-in fail with
-- OAuthAccountNotLinked.

-- Rename rather than drop+add: this preserves existing avatar values.
ALTER TABLE "User" RENAME COLUMN "profileImage" TO "image";

ALTER TABLE "User" ADD COLUMN "emailVerified" TIMESTAMP(3);

-- The authoritative Google subject lives in Account.providerAccountId.
-- googleId is now a nullable convenience column, backfilled on sign-in.
ALTER TABLE "User" ALTER COLUMN "googleId" DROP NOT NULL;
