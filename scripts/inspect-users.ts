/**
 * Prints every User with its linked OAuth accounts, sessions and workspaces.
 *
 * Useful for spotting the OAuthAccountNotLinked shape: a User row with
 * accounts=0 can never complete a Google sign-in, because NextAuth will not
 * attach an OAuth identity to a pre-existing unlinked user.
 *
 * Usage: npx tsx scripts/inspect-users.ts [--delete-unlinked]
 */
import { prisma } from '../lib/db/client';

async function main() {
  const users = await prisma.user.findMany({
    include: { accounts: true, sessions: true, ownedWorkspaces: true },
    orderBy: { createdAt: 'asc' },
  });

  if (users.length === 0) {
    console.log('No users.');
    return;
  }

  console.log(`${users.length} user(s):\n`);
  for (const u of users) {
    const flag = u.accounts.length === 0 ? '  ⚠ NO LINKED ACCOUNT — cannot sign in' : '';
    console.log(
      `  ${u.email}\n` +
        `    role=${u.role} status=${u.status} googleId=${u.googleId ?? 'null'}\n` +
        `    accounts=${u.accounts.length} sessions=${u.sessions.length} workspaces=${u.ownedWorkspaces.length}${flag}`
    );
  }

  if (!process.argv.includes('--delete-unlinked')) {
    const broken = users.filter((u) => u.accounts.length === 0);
    if (broken.length > 0) {
      console.log(
        `\n${broken.length} user(s) have no linked OAuth account. Re-run with --delete-unlinked to remove them so a fresh sign-in can provision cleanly.`
      );
    }
    return;
  }

  const broken = users.filter((u) => u.accounts.length === 0);
  for (const u of broken) {
    // Only safe to remove a user that never actually completed a sign-in
    // and therefore owns no real data.
    const owned = await prisma.dataset.count({ where: { ownerId: u.id } });
    const campaigns = await prisma.campaign.count({ where: { createdById: u.id } });
    if (owned > 0 || campaigns > 0) {
      console.log(`  skipping ${u.email} — owns ${owned} dataset(s), ${campaigns} campaign(s)`);
      continue;
    }
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.workspaceMember.deleteMany({ where: { userId: u.id } });
    await prisma.emailProviderAccount.deleteMany({ where: { userId: u.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: u.id } });
    await prisma.workspace.deleteMany({ where: { ownerId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
    console.log(`  removed unlinked user ${u.email}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
