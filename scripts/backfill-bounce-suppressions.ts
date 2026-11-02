/**
 * One-time: applies the bounce rule (lib/email/bounces.ts) to bounce notices that were stored
 * before it existed, so addresses that already bounced are suppressed too. Safe to re-run:
 * existing suppressions are left as they are.
 *
 *   DATABASE_URL=<database> npx tsx scripts/backfill-bounce-suppressions.ts [--dry-run]
 */
import { prisma } from '../lib/db/client';
import { parseBounce, suppressBounced } from '../lib/email/bounces';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const notices = await prisma.conversationMessage.findMany({
    where: { classification: { in: ['BOUNCE', 'DELIVERY_FAILURE'] } },
    select: {
      id: true,
      subject: true,
      plainTextBody: true,
      htmlBody: true,
      conversation: { select: { workspaceId: true, recipientEmail: true, account: { select: { emailAddress: true } } } },
    },
  });
  console.log(`${notices.length} stored bounce notice(s).`);
  let suppressed = 0;
  for (const n of notices) {
    const message = { subject: n.subject, plainTextBody: n.plainTextBody, htmlBody: n.htmlBody };
    const own = [n.conversation.account.emailAddress];
    if (dryRun) {
      const info = parseBounce(message, own);
      console.log(`${info.permanent ? 'PERMANENT' : 'temporary'} → ${info.recipients.join(', ') || `(conversation: ${n.conversation.recipientEmail})`} · ${info.detail}`);
      continue;
    }
    const done = await suppressBounced({ workspaceId: n.conversation.workspaceId, conversationRecipient: n.conversation.recipientEmail, message, ownAddresses: own });
    suppressed += done.length;
  }
  if (!dryRun) console.log(`Suppressed ${suppressed} address(es).`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
