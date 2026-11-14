/**
 * One-off cleanup: the same inbound email stored twice because it reached two connected mailboxes
 * of one workspace (a Google group address plus a CC, two group members).
 *
 * Groups inbound messages by (workspace, normalised Message-ID) across different mailboxes. Keeps
 * the OLDER conversation. DRY RUN unless --apply: prints every group. With --apply it removes a
 * later copy only when that conversation is a pure duplicate (exactly that one inbound message, no
 * outbound messages, notes, tags, follow-ups, scheduled replies, or an assignee other than the
 * owner). Anything else is listed for manual merge.
 *
 * Usage: npx tsx scripts/merge-duplicate-inbound.ts [--apply]   (DATABASE_URL from the environment)
 */
import { prisma } from '../lib/db/client';
import { groupCrossMailboxDuplicates, mergeBlockers, normalizeMessageId, type ConversationFacts } from '../lib/gmail/dedupe';

const apply = process.argv.includes('--apply');

async function main() {
  const rows = await prisma.conversationMessage.findMany({
    where: { direction: 'INBOUND', messageIdHeader: { not: null } },
    select: {
      messageIdHeader: true,
      createdAt: true,
      conversationId: true,
      conversation: { select: { workspaceId: true, emailProviderAccountId: true } },
    },
  });
  const candidates = rows.map((r) => ({
    conversationId: r.conversationId,
    workspaceId: r.conversation.workspaceId,
    mailboxId: r.conversation.emailProviderAccountId,
    messageIdHeader: r.messageIdHeader,
    createdAt: r.createdAt,
  }));
  const groups = groupCrossMailboxDuplicates(candidates);
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${rows.length} inbound messages with a Message-ID, ${groups.length} duplicated email(s).`);

  let removed = 0;
  let manual = 0;
  for (const group of groups) {
    const [keep, ...later] = group;
    console.log(`\nMessage-ID ${normalizeMessageId(keep!.messageIdHeader)} (workspace ${keep!.workspaceId})`);
    const describe = async (conversationId: string) => {
      const c = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: {
          id: true,
          subject: true,
          ownerId: true,
          assigneeId: true,
          account: { select: { emailAddress: true } },
          messages: { select: { direction: true } },
          _count: { select: { notes: true, tags: true, followUps: true, scheduledReplies: true } },
        },
      });
      if (!c) return null;
      const facts: ConversationFacts = {
        inboundCount: c.messages.filter((m) => m.direction === 'INBOUND').length,
        outboundCount: c.messages.filter((m) => m.direction === 'OUTBOUND').length,
        notes: c._count.notes,
        tags: c._count.tags,
        followUps: c._count.followUps,
        scheduledReplies: c._count.scheduledReplies,
        // Recruiter replies are assigned to their owner from the start; that is not manual work.
        assigneeId: c.assigneeId && c.assigneeId !== c.ownerId ? c.assigneeId : null,
      };
      return { c, facts };
    };
    const kept = await describe(keep!.conversationId);
    if (kept) console.log(`  KEEP   ${kept.c.id}  mailbox ${kept.c.account.emailAddress}  "${kept.c.subject}"  messages ${kept.c.messages.length}`);
    for (const dup of later) {
      const d = await describe(dup.conversationId);
      if (!d) continue;
      const blockers = mergeBlockers(d.facts);
      console.log(`  LATER  ${d.c.id}  mailbox ${d.c.account.emailAddress}  "${d.c.subject}"  messages ${d.c.messages.length}`);
      if (blockers.length > 0) {
        manual += 1;
        console.log(`         NOT removed, merge manually: ${blockers.join(', ')}`);
      } else if (!apply) {
        console.log('         pure duplicate: would be removed with --apply');
      } else {
        await prisma.conversation.delete({ where: { id: d.c.id } });
        removed += 1;
        console.log('         pure duplicate: removed');
      }
    }
  }
  console.log(`\n${apply ? `Removed ${removed}` : 'Nothing changed'}; ${manual} left for manual merge.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
