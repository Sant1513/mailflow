import { prisma } from '@/lib/db/client';

/**
 * Replies from the inbox must not go to an address that hard-bounced or reported spam: a
 * second bounce hurts the mailbox's reputation for every teammate (bounces are suppressed
 * org-wide, lib/email/bounces.ts). An unsubscribe doesn't block a reply — the person wrote
 * to us, answering them is expected. Returns the reason to show, or null when all is fine.
 */
export async function blockedReplyRecipient(workspaceId: string, recipients: (string | null | undefined)[]): Promise<string | null> {
  const emails = [...new Set(recipients.map((r) => r?.trim().toLowerCase()).filter((r): r is string => !!r))];
  if (!emails.length) return null;
  const hit = await prisma.emailSuppression.findFirst({
    where: { workspaceId, email: { in: emails }, reason: { in: ['BOUNCED', 'COMPLAINT'] } },
    select: { email: true, reason: true, detail: true },
  });
  if (!hit) return null;
  const why = hit.reason === 'COMPLAINT' ? 'marked our email as spam' : 'bounced before';
  return `${hit.email} ${why}${hit.detail ? ` (${hit.detail.slice(0, 160)})` : ''}, so it wasn't sent. Remove it from Suppressions if the address works again.`;
}
