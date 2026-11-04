import { prisma } from '@/lib/db/client';

/**
 * Replies to Recruiter Bulk Send emails (used by lib/gmail/ingest.ts and lib/gmail/sync.ts).
 *
 * Ownership: the conversation belongs to the admin who made the send — their workspace,
 * assigned to them — even when a teammate's backup mailbox carried the email. The mailbox
 * owner doesn't see it (access is by workspace; see lib/conversations/access.ts).
 *
 * One conversation per recruiter: with BCC, every recruiter who answers lands in the SAME
 * Gmail thread in the sending mailbox. A conversation is keyed by (mailbox, gmailThreadId),
 * so a recruiter conversation stores "<gmail thread id>#<recruiter email>" as its key, and
 * gmailThreadOf() gives back the real thread id when replying.
 */
export interface RecruiterReplyMatch {
  blastId: string;
  organizationId: string;
  workspaceId: string;
  adminId: string;
}

const KEY_SEPARATOR = '#';

/** The conversation key for one recruiter's replies within a Gmail thread. */
export function recruiterThreadKey(gmailThreadId: string, email: string): string {
  return `${gmailThreadId}${KEY_SEPARATOR}${email.trim().toLowerCase()}`;
}

/** The Gmail thread a conversation lives in (strips the recruiter suffix; Gmail ids never contain '#'). */
export function gmailThreadOf(conversationKey: string | null): string | null {
  if (!conversationKey) return null;
  const at = conversationKey.indexOf(KEY_SEPARATOR);
  return at === -1 ? conversationKey : conversationKey.slice(0, at);
}

interface MailboxRef {
  id: string;
  organizationId: string;
}

/**
 * Which recruiter send a message answers, if any: by the Message-ID it replies to (any mailbox
 * in the organization — with Reply-To set, recruiters answer a different mailbox than the one
 * that sent), or by sitting in the Gmail thread the send started in this mailbox.
 */
export async function findRecruiterSend(mailbox: MailboxRef, referencedIds: string[], gmailThreadId: string | null): Promise<RecruiterReplyMatch | null> {
  const or = [
    ...(referencedIds.length ? [{ messageIdHeader: { in: referencedIds }, blast: { organizationId: mailbox.organizationId } }] : []),
    ...(gmailThreadId ? [{ gmailThreadId, accountId: mailbox.id }] : []),
  ];
  if (!or.length) return null;
  const group = await prisma.recruiterBlastGroup.findFirst({
    where: { status: 'SENT', OR: or },
    select: { blast: { select: { id: true, organizationId: true, workspaceId: true, createdById: true } } },
  });
  return group ? { blastId: group.blast.id, organizationId: group.blast.organizationId, workspaceId: group.blast.workspaceId, adminId: group.blast.createdById } : null;
}

/** Of these Gmail threads (this mailbox) / Message-IDs (the organization), which belong to recruiter sends — sync triage, bulk. */
export async function recruiterSendRefs(mailbox: MailboxRef, threadIds: string[], messageIds: string[]): Promise<{ threads: Set<string>; messageIds: Set<string> }> {
  const threads = new Set<string>();
  const ids = new Set<string>();
  if (!threadIds.length && !messageIds.length) return { threads, messageIds: ids };
  const rows = await prisma.recruiterBlastGroup.findMany({
    where: {
      status: 'SENT',
      OR: [
        ...(threadIds.length ? [{ gmailThreadId: { in: threadIds }, accountId: mailbox.id }] : []),
        ...(messageIds.length ? [{ messageIdHeader: { in: messageIds }, blast: { organizationId: mailbox.organizationId } }] : []),
      ],
    },
    select: { gmailThreadId: true, messageIdHeader: true, accountId: true },
  });
  for (const r of rows) {
    if (r.gmailThreadId && r.accountId === mailbox.id) threads.add(r.gmailThreadId);
    if (r.messageIdHeader) ids.add(r.messageIdHeader);
  }
  return { threads, messageIds: ids };
}

/** The recruiter as a contact in the admin's workspace (created on first reply). */
export async function recruiterContact(match: RecruiterReplyMatch, email: string, name: string | null): Promise<string> {
  const primaryEmail = email.trim().toLowerCase();
  const contact = await prisma.contact.upsert({
    where: { workspaceId_primaryEmail: { workspaceId: match.workspaceId, primaryEmail } },
    create: { organizationId: match.organizationId, workspaceId: match.workspaceId, primaryEmail, name: name?.trim() || null },
    update: {},
    select: { id: true },
  });
  return contact.id;
}

/** Marks the recruiter as having replied, for the send's page. */
export async function markRecruiterReplied(blastId: string, email: string, at: Date): Promise<void> {
  await prisma.recruiterBlastRecipient.updateMany({ where: { blastId, email: email.trim().toLowerCase(), repliedAt: null }, data: { repliedAt: at } });
}
