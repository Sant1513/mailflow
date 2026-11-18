import { prisma } from '@/lib/db/client';
import { MAX_GROUP_SIZE, type BlastMode } from '@/lib/recruiterSend/core';
import { stripRe } from '@/lib/recruiterSend/ui';

export { stripRe };

/**
 * Recruiter Follow-up (the "Recruiter Follow-up" tab): a second (third…) email to the recruiters of
 * a send that finished. A follow-up is an ordinary RecruiterBlast (same editor, check, sender,
 * progress and export) that points at the send it follows up:
 *   parentBlastId  the previous round; rootBlastId  the first send of the chain; round  2, 3…
 * Every recruiter carries sourceGroupId, the earlier Gmail message they last received. A message
 * to them goes into that Gmail thread (threadId + In-Reply-To + References) and from the same
 * mailbox, because Gmail only threads inside one mailbox. When that mailbox is unavailable the
 * person choosing the send decides (RecruiterBlast.onMailboxDown): WAIT for it, or FALLBACK to
 * another mailbox and start a new thread.
 */

/**
 * Who a follow-up goes to is a multi-select of SEGMENTS. Every recruiter who was sent an email is
 * in exactly one segment (bounced ones in none: they are never included), so ticking several
 * simply adds them up:
 *   NO_REPLY_OPENED    no reply, opened the last email (individual copies only)
 *   NO_REPLY_UNOPENED  no reply, did not open it (individual copies only)
 *   NO_REPLY_UNKNOWN   no reply, opens unknown (the last email went out in BCC)
 *   REPLIED            has already replied (to this or an earlier round)
 */
export const FOLLOW_UP_SEGMENTS = ['NO_REPLY_OPENED', 'NO_REPLY_UNOPENED', 'NO_REPLY_UNKNOWN', 'REPLIED'] as const;
export type FollowUpSegment = (typeof FOLLOW_UP_SEGMENTS)[number];
/** Everyone who has not replied: the default selection. */
export const NOT_REPLIED_SEGMENTS: FollowUpSegment[] = ['NO_REPLY_OPENED', 'NO_REPLY_UNOPENED', 'NO_REPLY_UNKNOWN'];

/** Audience names saved by the first version (one choice); still accepted. */
export const LEGACY_AUDIENCES = ['NOT_REPLIED', 'NOT_REPLIED_OPENED', 'NOT_REPLIED_UNOPENED', 'EVERYONE'] as const;
const LEGACY: Record<string, FollowUpSegment[]> = {
  NOT_REPLIED: NOT_REPLIED_SEGMENTS,
  NOT_REPLIED_OPENED: ['NO_REPLY_OPENED'],
  NOT_REPLIED_UNOPENED: ['NO_REPLY_UNOPENED'],
  EVERYONE: [...FOLLOW_UP_SEGMENTS],
};

/** The segments a saved value stands for: "A,B" lists, or a legacy audience name. Unknown names are dropped. */
export function parseSegments(saved: string | null | undefined): FollowUpSegment[] {
  const parts = (saved ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const out = new Set<FollowUpSegment>();
  for (const p of parts) {
    if (LEGACY[p]) LEGACY[p]!.forEach((s) => out.add(s));
    else if ((FOLLOW_UP_SEGMENTS as readonly string[]).includes(p)) out.add(p as FollowUpSegment);
  }
  return FOLLOW_UP_SEGMENTS.filter((s) => out.has(s));
}
export type OnMailboxDown = 'WAIT' | 'FALLBACK';

export function followUpSubject(subject: string): string {
  return `Re: ${stripRe(subject)}`;
}

/** A recruiter of the chain, with what is known about them across every round sent so far. */
export interface Candidate {
  email: string;
  name: string | null;
  data: Record<string, string> | null;
  /** The Gmail message (group) they last received. */
  sourceGroupId: string | null;
  replied: boolean;
  /** Opened the last email: known only when that email was an individual copy, else null. */
  opened: boolean | null;
  /** The address bounced or was rejected in some round of this chain. */
  bounced: boolean;
  /** On the workspace's suppression list (unsubscribed, bounced, rejected, complaint…): never emailed again. */
  suppressed: boolean;
  lastSentAt: Date | null;
}

/**
 * Everyone who was sent an email in this chain (the first send and its follow-ups). With a
 * workspace, anyone on its suppression list is flagged, so they are left out of every audience.
 */
export async function chainCandidates(rootId: string, workspaceId?: string | null): Promise<Candidate[]> {
  const rows = await prisma.recruiterBlastRecipient.findMany({
    where: { blast: { OR: [{ id: rootId }, { rootBlastId: rootId }] } },
    orderBy: [{ sentAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
    select: { email: true, name: true, data: true, status: true, groupId: true, sentAt: true, repliedAt: true, openCount: true, blast: { select: { mode: true } } },
  });
  const by = new Map<string, Candidate & { sent: boolean }>();
  for (const r of rows) {
    const email = r.email.toLowerCase();
    const c = by.get(email) ?? { email, name: null, data: null, sourceGroupId: null, replied: false, opened: null, bounced: false, suppressed: false, lastSentAt: null, sent: false };
    if (r.repliedAt) c.replied = true;
    if (r.status === 'BOUNCED') c.bounced = true;
    if (r.status === 'SENT') {
      c.sent = true;
      c.name = r.name ?? c.name;
      c.data = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? (r.data as Record<string, string>) : c.data;
      c.sourceGroupId = r.groupId;
      c.lastSentAt = r.sentAt;
      c.opened = r.blast.mode === 'INDIVIDUAL' ? r.openCount > 0 : null;
    }
    by.set(email, c);
  }
  const list = [...by.values()].filter((c) => c.sent).map(({ sent: _sent, ...c }) => c);
  if (workspaceId && list.length) {
    const blocked = new Set<string>();
    for (let i = 0; i < list.length; i += 1000) {
      const rows = await prisma.emailSuppression.findMany({ where: { workspaceId, email: { in: list.slice(i, i + 1000).map((c) => c.email), mode: 'insensitive' } }, select: { email: true } });
      for (const r of rows) blocked.add(r.email.toLowerCase());
    }
    for (const c of list) c.suppressed = blocked.has(c.email);
  }
  return list;
}

/** The workspace a draft belongs to (its suppression list decides who can be emailed). */
async function workspaceOf(blastId: string): Promise<string | null> {
  return (await prisma.recruiterBlast.findUnique({ where: { id: blastId }, select: { workspaceId: true } }))?.workspaceId ?? null;
}

/** The one segment a recruiter is in; null for a bounced or suppressed recruiter (never included). */
/** What a segment depends on (shared with the Quick Send follow-up). */
export type Segmentable = Pick<Candidate, 'replied' | 'opened' | 'bounced' | 'suppressed'>;

export function segmentOf(c: Segmentable): FollowUpSegment | null {
  if (c.bounced || c.suppressed) return null;
  if (c.replied) return 'REPLIED';
  if (c.opened === true) return 'NO_REPLY_OPENED';
  if (c.opened === false) return 'NO_REPLY_UNOPENED';
  return 'NO_REPLY_UNKNOWN';
}

/** Is the recruiter in any of the ticked segments? */
export function inSegments(c: Segmentable, segments: readonly FollowUpSegment[]): boolean {
  const s = segmentOf(c);
  return s !== null && segments.includes(s);
}

export type SegmentCounts = Record<FollowUpSegment, number> & { bounced: number; total: number };

/** How many recruiters are in each segment (bounced ones counted apart; total = everyone ever sent). */
export function segmentCounts(list: Segmentable[]): SegmentCounts {
  const counts: SegmentCounts = { NO_REPLY_OPENED: 0, NO_REPLY_UNOPENED: 0, NO_REPLY_UNKNOWN: 0, REPLIED: 0, bounced: 0, total: list.length };
  for (const c of list) {
    const s = segmentOf(c);
    if (s) counts[s]++;
    else counts.bounced++;
  }
  return counts;
}

const rowFor = (blastId: string, c: Candidate) => ({
  blastId,
  email: c.email,
  name: c.name,
  data: c.data ?? undefined,
  sourceGroupId: c.sourceGroupId,
});

/** Replaces the follow-up draft's recruiters with the ticked segments (a snapshot; edit it afterwards). */
export async function applyAudience(blastId: string, rootId: string, segments: readonly FollowUpSegment[]): Promise<number> {
  const picked = FOLLOW_UP_SEGMENTS.filter((s) => segments.includes(s));
  const chosen = (await chainCandidates(rootId, await workspaceOf(blastId))).filter((c) => inSegments(c, picked));
  await prisma.$transaction(
    async (tx) => {
      await tx.recruiterBlastRecipient.deleteMany({ where: { blastId } });
      for (let i = 0; i < chosen.length; i += 1000) {
        await tx.recruiterBlastRecipient.createMany({ data: chosen.slice(i, i + 1000).map((c) => rowFor(blastId, c)), skipDuplicates: true });
      }
      await tx.recruiterBlast.update({ where: { id: blastId }, data: { followUpAudience: picked.join(',') } });
    },
    { timeout: 60_000 },
  );
  return chosen.length;
}

/** Add recruiters of the chain back (or new addresses: they start a thread of their own). */
export async function addToAudience(blastId: string, rootId: string, emails: string[]): Promise<{ added: number; fromChain: number; skippedBounced: number }> {
  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return { added: 0, fromChain: 0, skippedBounced: 0 };
  const workspaceId = await workspaceOf(blastId);
  const known = new Map((await chainCandidates(rootId, workspaceId)).map((c) => [c.email, c]));
  const have = new Set((await prisma.recruiterBlastRecipient.findMany({ where: { blastId, email: { in: wanted } }, select: { email: true } })).map((r) => r.email.toLowerCase()));
  // A recruiter whose address bounced in any round, or is on the suppression list, is never added, however they get here (tick or typed):
  // a bounced address has no "sent" row, so it is looked up on its own.
  const bouncedRows = await prisma.recruiterBlastRecipient.findMany({
    where: { blast: { OR: [{ id: rootId }, { rootBlastId: rootId }] }, status: 'BOUNCED', email: { in: wanted, mode: 'insensitive' } },
    select: { email: true },
  });
  const bounced = new Set([...bouncedRows.map((r) => r.email.toLowerCase()), ...[...known.values()].filter((c) => c.bounced || c.suppressed).map((c) => c.email)]);
  // A typed address that is on the suppression list (and not part of the chain) is refused too.
  if (workspaceId) {
    const typed = wanted.filter((e) => !known.has(e));
    for (let i = 0; i < typed.length; i += 1000) {
      const rows = await prisma.emailSuppression.findMany({ where: { workspaceId, email: { in: typed.slice(i, i + 1000), mode: 'insensitive' } }, select: { email: true } });
      for (const r of rows) bounced.add(r.email.toLowerCase());
    }
  }
  const rows = wanted.filter((e) => !have.has(e) && !bounced.has(e)).map((e) => rowFor(blastId, known.get(e) ?? { email: e, name: null, data: null, sourceGroupId: null, replied: false, opened: null, bounced: false, suppressed: false, lastSentAt: null }));
  if (rows.length) await prisma.recruiterBlastRecipient.createMany({ data: rows, skipDuplicates: true });
  return { added: rows.length, fromChain: rows.filter((r) => known.has(r.email)).length, skippedBounced: wanted.filter((e) => bounced.has(e)).length };
}

/** One Gmail message of a follow-up: its recruiters and the earlier message it replies to. */
export interface FollowUpGroup { ids: string[]; sourceGroupId: string | null }

/**
 * Recruiters → Gmail messages. Individual copies: one each, replying to that recruiter's last
 * email. BCC: recruiters who share an earlier message stay together (one BCC reply in that
 * thread, from its mailbox), at most `groupSize` per message; recruiters new to the chain go
 * together in messages of their own.
 */
export function followUpGroups(rows: { id: string; sourceGroupId: string | null }[], mode: BlastMode, groupSize: number): FollowUpGroup[] {
  if (mode === 'INDIVIDUAL') return rows.map((r) => ({ ids: [r.id], sourceGroupId: r.sourceGroupId }));
  const size = Math.max(1, Math.min(MAX_GROUP_SIZE, groupSize));
  const buckets = new Map<string, FollowUpGroup>();
  for (const r of rows) {
    const key = r.sourceGroupId ?? '';
    const b = buckets.get(key) ?? { ids: [], sourceGroupId: r.sourceGroupId };
    b.ids.push(r.id);
    buckets.set(key, b);
  }
  const out: FollowUpGroup[] = [];
  for (const b of buckets.values()) {
    for (let i = 0; i < b.ids.length; i += size) out.push({ ids: b.ids.slice(i, i + size), sourceGroupId: b.sourceGroupId });
  }
  return out;
}

interface PinRoom { accountId: string; messagesLeft: number; peopleLeft: number; sendLimit: number | null }

/**
 * Which mailbox each follow-up message is planned to go from. A message replying to an earlier
 * one is pinned to that message's mailbox (its thread lives there). Pinned but no room today:
 * WAIT → it goes later from that mailbox; FALLBACK → any mailbox with room (a new thread). Messages
 * with nothing to reply to are spread round-robin. Every mailbox sends its round together.
 */
export function planFollowUpMailboxes(groups: { size: number; pinnedAccountId: string | null }[], mailboxes: PinRoom[], onDown: OnMailboxDown): { mailbox: number | null; round: number | null }[] {
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
  let next = 0;
  return groups.map((g) => {
    const pin = g.pinnedAccountId ? mailboxes.findIndex((m) => m.accountId === g.pinnedAccountId) : -1;
    if (pin >= 0 && fits(pin, g.size)) return { mailbox: pin, round: take(pin, g.size) };
    if (g.pinnedAccountId && onDown === 'WAIT') return { mailbox: null, round: null };
    for (let tries = 0; tries < room.length; tries++) {
      const i = (next + tries) % room.length;
      if (fits(i, g.size)) {
        next = (i + 1) % room.length;
        return { mailbox: i, round: take(i, g.size) };
      }
    }
    return { mailbox: null, round: null };
  });
}

/**
 * The Gmail thread to continue: the earlier message's thread, In-Reply-To its Message-ID and the
 * References chain of every earlier message. Only from the mailbox that sent that message (Gmail
 * threads within one mailbox); otherwise null and the email starts a new thread.
 */
export async function threadFor(sourceGroupId: string, accountId: string): Promise<{ threadId: string; inReplyTo: string; references: string } | null> {
  const chain: { accountId: string | null; gmailThreadId: string | null; messageIdHeader: string | null }[] = [];
  let id: string | null = sourceGroupId;
  for (let hops = 0; id && hops < 25; hops++) {
    const g: { accountId: string | null; gmailThreadId: string | null; messageIdHeader: string | null; inReplyToGroupId: string | null } | null = await prisma.recruiterBlastGroup.findUnique({
      where: { id },
      select: { accountId: true, gmailThreadId: true, messageIdHeader: true, inReplyToGroupId: true },
    });
    if (!g) break;
    chain.push(g);
    id = g.inReplyToGroupId;
  }
  const last = chain[0];
  if (!last || last.accountId !== accountId || !last.gmailThreadId || !last.messageIdHeader) return null;
  const references = chain.map((g) => g.messageIdHeader).filter((m): m is string => !!m).reverse().join(' ');
  return { threadId: last.gmailThreadId, inReplyTo: last.messageIdHeader, references };
}

/** The mailboxes that carried each earlier message (for pinning a plan). */
export async function sourceAccounts(groupIds: (string | null)[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(groupIds.filter((g): g is string => !!g))];
  if (!ids.length) return new Map();
  const rows = await prisma.recruiterBlastGroup.findMany({ where: { id: { in: ids } }, select: { id: true, accountId: true } });
  return new Map(rows.map((r) => [r.id, r.accountId]));
}
