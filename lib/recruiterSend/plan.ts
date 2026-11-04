import { prisma } from '@/lib/db/client';
import { checkAddresses } from '@/lib/email/addressCheck';
import { dailyLimit, DAILY_UNIQUE_RECIPIENT_LIMIT, usageLast24h } from '@/lib/queue/drain';
import { isValidEmail } from '@/lib/quickSend/prepare';
import { MAX_GROUP_SIZE, planGroups, type BlastMode } from '@/lib/recruiterSend/core';

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
  /** Batch by batch: how many recruiters and the mailbox it is planned to go from (first 500). */
  batches: { seq: number; size: number; mailbox: string | null }[];
  /** Everyone with what will happen to them (first 2,000): their batch and mailbox, or why they're skipped. */
  people: { email: string; name: string | null; batch: number | null; mailbox: string | null; skipped: string | null }[];
}

/**
 * Which mailbox each batch is planned to go from, the way the sender picks: the first chosen
 * mailbox that still has room under the limit set for this send and Google's daily limits.
 * A batch with no room today goes out when allowances free up (mailbox: null).
 */
export function assignMailboxes(
  sizes: number[],
  mailboxes: { emailAddress: string; messagesLeft: number; peopleLeft: number; sendLimit: number | null }[],
): (string | null)[] {
  const room = mailboxes.map((m) => ({ ...m, sendLeft: m.sendLimit ?? Infinity }));
  return sizes.map((size) => {
    const m = room.find((r) => r.messagesLeft >= 1 && r.peopleLeft >= size && r.sendLeft >= size);
    if (!m) return null;
    m.messagesLeft -= 1;
    m.peopleLeft -= size;
    m.sendLeft -= size;
    return m.emailAddress;
  });
}

export async function planBlast(blast: { id: string; workspaceId: string; mode: string; groupSize: number; gapSeconds: number; accountIds: string[]; accountLimits?: unknown }): Promise<BlastPlan> {
  // A stable order: the batches the check shows are the batches start creates.
  const recipients = await prisma.recruiterBlastRecipient.findMany({ where: { blastId: blast.id }, orderBy: { id: 'asc' }, select: { id: true, email: true, name: true } });
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

  const limits = (blast.accountLimits && typeof blast.accountLimits === 'object' ? blast.accountLimits : {}) as Record<string, number>;
  const ordered = blast.accountIds.map((id) => capacity.find((c) => c.accountId === id)).filter((c): c is (typeof capacity)[number] => !!c);
  const groups = planGroups(eligibleIds, mode, blast.groupSize);
  const planned = assignMailboxes(
    groups.map((g) => g.length),
    ordered.map((c) => ({ emailAddress: c.emailAddress, messagesLeft: c.messagesLeft, peopleLeft: c.peopleLeft, sendLimit: Number(limits[c.accountId]) > 0 ? Number(limits[c.accountId]) : null })),
  );
  const batchOf = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((id) => batchOf.set(id, i)));
  const people = recipients.slice(0, 2000).map((r) => {
    const b = batchOf.get(r.id);
    return { email: r.email, name: r.name, batch: b === undefined ? null : b + 1, mailbox: b === undefined ? null : planned[b] ?? null, skipped: skippedReasons.get(r.id) ?? null };
  });
  const batches = groups.slice(0, 500).map((g, i) => ({ seq: i + 1, size: g.length, mailbox: planned[i] ?? null }));

  return { total: recipients.length, eligibleIds, skippedReasons, skipped: skipped.slice(0, 200), skippedByReason, messages, perMessage, capacity, messagesPossibleToday, estimatedMinutes, batches, people };
}
