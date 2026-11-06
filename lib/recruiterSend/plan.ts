import { prisma } from '@/lib/db/client';
import { checkAddresses } from '@/lib/email/addressCheck';
import { dailyLimit, DAILY_UNIQUE_RECIPIENT_LIMIT, usageLast24h } from '@/lib/queue/drain';
import { isValidEmail } from '@/lib/quickSend/prepare';
import { MAX_GROUP_SIZE, planGroups, previewHtml, type BlastMode } from '@/lib/recruiterSend/core';
import { missingValues, personalize, variableCheck } from '@/lib/recruiterSend/personalize';

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
  batches: { seq: number; size: number; mailbox: string | null; round: number | null }[];
  /** PARALLEL: rounds of one message from every mailbox; SEQUENTIAL: one message at a time. */
  sendOrder: SendOrder;
  /** How many rounds (PARALLEL) or messages (SEQUENTIAL) the planned batches take. */
  rounds: number;
  /** Mailbox id each batch is planned to go from (in batch order), for start. */
  plannedAccountIds: (string | null)[];
  /** Everyone with what will happen to them (first 2,000): their batch and mailbox, or why they're skipped. */
  people: { email: string; name: string | null; batch: number | null; round: number | null; mailbox: string | null; skipped: string | null }[];
  /** {{Column}} use: which variables, which match no column, and one recruiter's values (the preview uses them). */
  personalization: { columns: string[]; emailColumn: string | null; used: string[]; unknown: string[]; bccConflict: boolean; sample: { email: string; values: Record<string, string> } | null };
}

export type SendOrder = 'PARALLEL' | 'SEQUENTIAL';
export const SEND_ORDERS: SendOrder[] = ['PARALLEL', 'SEQUENTIAL'];

interface MailboxRoom { messagesLeft: number; peopleLeft: number; sendLimit: number | null }

/**
 * Which mailbox each batch is planned to go from, and in which round.
 *  PARALLEL   — round robin: batch 1 from mailbox 1, batch 2 from mailbox 2, … then round 2.
 *               A mailbox with no room left (its limit for this send, Google's daily limits)
 *               drops out and the others carry on. Every mailbox sends its round at once.
 *  SEQUENTIAL — the first chosen mailbox until it has no room, then the next; one message per
 *               round (the old way).
 * A batch with no room today goes out when allowances free up (mailbox: null).
 */
export function planMailboxes(sizes: number[], mailboxes: MailboxRoom[], order: SendOrder): { mailbox: number | null; round: number | null }[] {
  const room = mailboxes.map((m) => ({ messagesLeft: m.messagesLeft, peopleLeft: m.peopleLeft, sendLeft: m.sendLimit ?? Infinity, sent: 0 }));
  const fits = (i: number, size: number) => room[i]!.messagesLeft >= 1 && room[i]!.peopleLeft >= size && room[i]!.sendLeft >= size;
  const take = (i: number, size: number) => {
    const r = room[i]!;
    r.messagesLeft -= 1;
    r.peopleLeft -= size;
    r.sendLeft -= size;
    r.sent += 1;
    return r.sent;
  };
  if (order === 'SEQUENTIAL') {
    let n = 0;
    return sizes.map((size) => {
      const i = room.findIndex((_, k) => fits(k, size));
      if (i < 0) return { mailbox: null, round: null };
      take(i, size);
      return { mailbox: i, round: ++n };
    });
  }
  let next = 0;
  return sizes.map((size) => {
    for (let tries = 0; tries < room.length; tries++) {
      const i = (next + tries) % room.length;
      if (fits(i, size)) {
        next = (i + 1) % room.length;
        return { mailbox: i, round: take(i, size) };
      }
    }
    return { mailbox: null, round: null };
  });
}

/** Mailbox address per batch, one mailbox after another (kept for callers and tests). */
export function assignMailboxes(
  sizes: number[],
  mailboxes: { emailAddress: string; messagesLeft: number; peopleLeft: number; sendLimit: number | null }[],
  order: SendOrder = 'SEQUENTIAL',
): (string | null)[] {
  return planMailboxes(sizes, mailboxes, order).map((p) => (p.mailbox === null ? null : mailboxes[p.mailbox]!.emailAddress));
}

/**
 * Minutes the planned batches take: PARALLEL = one pause per round (all mailboxes send their
 * round together, a few seconds apart); SEQUENTIAL = one pause per message.
 */
export function estimateMinutes(rounds: number, gapSeconds: number, order: SendOrder, mailboxes: number): number {
  if (rounds <= 0) return 0;
  const perRound = order === 'PARALLEL' ? gapSeconds + Math.min(mailboxes, 10) * 1.5 : gapSeconds;
  return Math.max(1, Math.ceil((rounds * perRound) / 60));
}

export async function planBlast(blast: { id: string; workspaceId: string; mode: string; sendOrder?: string; groupSize: number; gapSeconds: number; accountIds: string[]; accountLimits?: unknown; subject?: string; html?: string; plainText?: string; columns?: string[]; emailColumn?: string | null }): Promise<BlastPlan> {
  // A stable order: the batches the check shows are the batches start creates.
  const recipients = await prisma.recruiterBlastRecipient.findMany({ where: { blastId: blast.id }, orderBy: { id: 'asc' }, select: { id: true, email: true, name: true, data: true } });
  const problems = await checkAddresses(recipients.map((r) => r.email), blast.workspaceId);
  const eligibleIds: string[] = [];
  const skipped: { email: string; reason: string }[] = [];
  const skippedReasons = new Map<string, string>();
  const skippedByReason: Record<string, number> = {};
  const content = { subject: blast.subject ?? '', html: blast.html ?? '', plainText: blast.plainText ?? '' };
  const vars = variableCheck({ ...content, mode: blast.mode, columns: blast.columns });
  // Only individual copies are personalised (BCC is blocked at start when variables are used).
  const personalised = blast.mode === 'INDIVIDUAL' && vars.used.length > 0;
  for (const r of recipients) {
    const missing = personalised ? missingValues(content, r) : [];
    const problem = !isValidEmail(r.email)
      ? { kind: 'INVALID', detail: `"${r.email}" is not a valid email address.` }
      : problems.get(r.email.toLowerCase()) ??
        (missing.length ? { kind: 'MISSING_VALUE', detail: `No value for ${missing.map((m) => `{{${m}}}`).join(', ')} (fill it in the list, or write {{${missing[0]} | fallback}}).` } : undefined);
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

  const limits = (blast.accountLimits && typeof blast.accountLimits === 'object' ? blast.accountLimits : {}) as Record<string, number>;
  const ordered = blast.accountIds.map((id) => capacity.find((c) => c.accountId === id)).filter((c): c is (typeof capacity)[number] => !!c);
  const groups = planGroups(eligibleIds, mode, blast.groupSize);
  const sendOrder: SendOrder = blast.sendOrder === 'SEQUENTIAL' ? 'SEQUENTIAL' : 'PARALLEL';
  const assigned = planMailboxes(
    groups.map((g) => g.length),
    ordered.map((c) => ({ messagesLeft: c.messagesLeft, peopleLeft: c.peopleLeft, sendLimit: Number(limits[c.accountId]) > 0 ? Number(limits[c.accountId]) : null })),
    sendOrder,
  );
  const planned = assigned.map((a) => (a.mailbox === null ? null : ordered[a.mailbox]!.emailAddress));
  const plannedAccountIds = assigned.map((a) => (a.mailbox === null ? null : ordered[a.mailbox]!.accountId));
  const rounds = assigned.reduce((n, a) => Math.max(n, a.round ?? 0), 0);
  // Batches with no room today go out later; the estimate covers the ones that can go today.
  const estimatedMinutes = estimateMinutes(rounds, blast.gapSeconds, sendOrder, ordered.length);
  const batchOf = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((id) => batchOf.set(id, i)));
  const people = recipients.slice(0, 2000).map((r) => {
    const b = batchOf.get(r.id);
    return { email: r.email, name: r.name, batch: b === undefined ? null : b + 1, round: b === undefined ? null : assigned[b]?.round ?? null, mailbox: b === undefined ? null : planned[b] ?? null, skipped: skippedReasons.get(r.id) ?? null };
  });
  const batches = groups.slice(0, 500).map((g, i) => ({ seq: i + 1, size: g.length, mailbox: planned[i] ?? null, round: assigned[i]?.round ?? null }));

  const first = recipients.find((r) => eligibleIds[0] === r.id) ?? recipients[0];
  const personalization = {
    columns: blast.columns ?? [],
    emailColumn: blast.emailColumn ?? null,
    ...vars,
    sample: first && vars.used.length ? { email: first.email, values: personalize(content, first).resolved } : null,
  };

  return { personalization, total: recipients.length, eligibleIds, skippedReasons, skipped: skipped.slice(0, 200), skippedByReason, messages, perMessage, capacity, messagesPossibleToday, estimatedMinutes, batches, people, sendOrder, rounds, plannedAccountIds };
}

/**
 * The preview the page shows: individual copies use the first recruiter's own values, so
 * {{Name}} and {{UTM link}} appear as that recruiter will see them. No tracking pixel.
 */
export async function personalisedPreview(blast: { id: string; html: string; subject: string; plainText: string; mode: string; workspaceId: string }): Promise<{ html: string; subject: string; recipient: string | null }> {
  if (blast.mode !== 'INDIVIDUAL' || !variableCheck({ ...blast, columns: [] }).used.length) return { html: previewHtml(blast), subject: blast.subject, recipient: null };
  const row = await prisma.recruiterBlastRecipient.findFirst({ where: { blastId: blast.id }, orderBy: { id: 'asc' }, select: { email: true, name: true, data: true } });
  if (!row) return { html: previewHtml(blast), subject: blast.subject, recipient: null };
  const p = personalize(blast, row);
  return { html: previewHtml({ ...blast, html: p.html }), subject: p.subject, recipient: row.email };
}
