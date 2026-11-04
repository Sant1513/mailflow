import { prisma } from '@/lib/db/client';
import { checkAddresses } from '@/lib/email/addressCheck';
import { dailyLimit, DAILY_UNIQUE_RECIPIENT_LIMIT, usageLast24h } from '@/lib/queue/drain';
import { isValidEmail } from '@/lib/quickSend/prepare';
import { MAX_GROUP_SIZE, type BlastMode } from '@/lib/recruiterSend/core';

/**
 * The pre-send check for a recruiter send: who will get it, who is skipped and why (same
 * address checks as campaigns: unsubscribed, bounced, dead domains, typos, no-reply,
 * throwaway), how many Gmail messages that makes, and how much the chosen mailboxes can still
 * send today.
 */
export interface BlastPlan {
  total: number;
  eligibleIds: string[];
  /** Every skipped recipient id with its reason (for marking them at start). */
  skippedReasons: Map<string, string>;
  skipped: { email: string; reason: string }[];
  skippedByReason: Record<string, number>;
  messages: number;
  perMessage: number;
  capacity: { accountId: string; emailAddress: string; messagesLeft: number; peopleLeft: number }[];
  /** Messages the mailboxes can carry today (by the stricter of messages / people left). */
  messagesPossibleToday: number;
  estimatedMinutes: number;
}

export async function planBlast(blast: { id: string; workspaceId: string; mode: string; groupSize: number; gapSeconds: number; accountIds: string[] }): Promise<BlastPlan> {
  const recipients = await prisma.recruiterBlastRecipient.findMany({ where: { blastId: blast.id }, select: { id: true, email: true } });
  const problems = await checkAddresses(recipients.map((r) => r.email), blast.workspaceId);
  const eligibleIds: string[] = [];
  const skipped: { email: string; reason: string }[] = [];
  const skippedReasons = new Map<string, string>();
  const skippedByReason: Record<string, number> = {};
  for (const r of recipients) {
    const problem = !isValidEmail(r.email) ? { kind: 'INVALID', detail: `"${r.email}" is not a valid email address.` } : problems.get(r.email.toLowerCase());
    if (problem) {
      skipped.push({ email: r.email, reason: problem.detail });
      skippedReasons.set(r.id, problem.detail);
      skippedByReason[problem.kind] = (skippedByReason[problem.kind] ?? 0) + 1;
    } else eligibleIds.push(r.id);
  }

  const mode = blast.mode as BlastMode;
  const perMessage = mode === 'INDIVIDUAL' ? 1 : Math.min(MAX_GROUP_SIZE, Math.max(1, blast.groupSize));
  const messages = Math.ceil(eligibleIds.length / perMessage);

  const accounts = blast.accountIds.length
    ? await prisma.emailProviderAccount.findMany({ where: { id: { in: blast.accountIds } }, select: { id: true, emailAddress: true, status: true } })
    : [];
  const capacity = await Promise.all(
    accounts
      .filter((a) => a.status === 'CONNECTED')
      .map(async (a) => {
        const u = await usageLast24h(a.id);
        return { accountId: a.id, emailAddress: a.emailAddress, messagesLeft: Math.max(0, dailyLimit() - u.messages), peopleLeft: Math.max(0, DAILY_UNIQUE_RECIPIENT_LIMIT - u.unique.size) };
      }),
  );
  const messagesPossibleToday = capacity.reduce((n, c) => n + Math.min(c.messagesLeft, Math.floor(c.peopleLeft / perMessage)), 0);
  const estimatedMinutes = Math.ceil((Math.min(messages, messagesPossibleToday || messages) * blast.gapSeconds) / 60);

  return { total: recipients.length, eligibleIds, skippedReasons, skipped: skipped.slice(0, 200), skippedByReason, messages, perMessage, capacity, messagesPossibleToday, estimatedMinutes };
}
