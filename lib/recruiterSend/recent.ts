import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { emailKey } from '@/lib/recruiterSend/emailKey';

/**
 * Repeat guard for recruiter sends: "has this person been emailed from MailFlow lately?" People are matched by emailKey
 * (Gmail dots and +tags ignored, see emailKey.ts), and "emailed" means any of:
 *   - another recruiter send (including follow-ups) that went out in the window,
 *   - a campaign or Quick Send email,
 *   - a manual reply written in the Inbox (outbound messages that are not just the copy of a campaign email),
 *   - in 'plan' mode only: a recruiter send that is queued or scheduled but has not gone out yet, so two sends started
 *     minutes apart can't both email the same person. In 'send' mode (the check made just before each message goes out)
 *     queued emails do not count, only what really went out (or is going out this second), so of two overlapping sends
 *     the first to send wins and the other skips, instead of both skipping.
 * A separate cool-off ("do not contact until") lives on the Contact record (coolOffs below).
 */

import { clampRepeatDays, DEFAULT_REPEAT_DAYS, MAX_REPEAT_DAYS, SHORT_WINDOW_DAYS } from '@/lib/recruiterSend/repeatDays';
export { DEFAULT_REPEAT_DAYS, MAX_REPEAT_DAYS, SHORT_WINDOW_DAYS };
const CHUNK = 5000;
const DAY_MS = 86_400_000;

export type RecentMode = 'plan' | 'send';
export type RecentKind = 'send' | 'campaign' | 'reply';

export interface RecentContact {
  /** The person's emailKey. */
  email: string;
  /** When it went out (a queued send counts as now). */
  at: Date;
  /** Queued / scheduled in another send, not sent yet. */
  pending: boolean;
  subject: string;
  /** "Recruiter send “Name”", "Campaign “Name”" or "Inbox reply". */
  source: string;
  kind: RecentKind;
  from: string | null;
  /** How many emails in the window (the latest one is described above). */
  count: number;
}

export const repeatWindow = clampRepeatDays;

type Entry = Omit<RecentContact, 'count'>;
const norm = (s: string) => s.trim().toLowerCase();
const REPLY_DUPLICATE_MS = 10 * 60_000;

/** Every email in the window per person, newest first lookups are done by the callers. */
async function collect(opts: { organizationId: string; keys: string[]; cutoff: Date; excludeBlastId?: string; mode: RecentMode; now: Date }): Promise<Map<string, Entry[]>> {
  const out = new Map<string, Entry[]>();
  const push = (e: Entry) => { const l = out.get(e.email); if (l) l.push(e); else out.set(e.email, [e]); };
  const exclude = opts.excludeBlastId ?? '';

  for (let i = 0; i < opts.keys.length; i += CHUNK) {
    const chunk = opts.keys.slice(i, i + CHUNK);
    const pendingClause = opts.mode === 'plan'
      ? Prisma.sql`(r."status" = 'QUEUED' AND b."status" IN ('SENDING', 'SCHEDULED', 'PAUSED'))`
      : Prisma.sql`(r."status" = 'QUEUED' AND b."status" = 'SENDING' AND g."status" = 'SENDING')`;
    const [blasts, jobs, replies] = await Promise.all([
      prisma.$queryRaw<{ key: string; status: string; sentAt: Date | null; name: string; subject: string; fromEmail: string | null }[]>(Prisma.sql`
        SELECT mailflow_email_key(r."email") AS key, r."status", r."sentAt", b."name", b."subject", g."fromEmail"
        FROM "RecruiterBlastRecipient" r
        JOIN "RecruiterBlast" b ON b."id" = r."blastId"
        LEFT JOIN "RecruiterBlastGroup" g ON g."id" = r."groupId"
        WHERE mailflow_email_key(r."email") = ANY(${chunk}::text[]) AND r."blastId" <> ${exclude} AND b."organizationId" = ${opts.organizationId}
          AND ((r."status" = 'SENT' AND r."sentAt" >= ${opts.cutoff}) OR ${pendingClause})`),
      prisma.$queryRaw<{ key: string; sentAt: Date; subject: string; fromEmail: string | null; name: string }[]>(Prisma.sql`
        SELECT mailflow_email_key(j."toEmail") AS key, j."sentAt", j."subject", j."fromEmail", c."name"
        FROM "EmailJob" j JOIN "Campaign" c ON c."id" = j."campaignId"
        WHERE mailflow_email_key(j."toEmail") = ANY(${chunk}::text[]) AND j."status" = 'SENT' AND j."sentAt" >= ${opts.cutoff} AND c."organizationId" = ${opts.organizationId}`),
      prisma.$queryRaw<{ key: string; sentAt: Date; subject: string | null; senderEmail: string }[]>(Prisma.sql`
        SELECT mailflow_email_key(m."recipientEmail") AS key, m."sentAt", m."subject", m."senderEmail"
        FROM "ConversationMessage" m JOIN "Conversation" c ON c."id" = m."conversationId"
        WHERE mailflow_email_key(m."recipientEmail") = ANY(${chunk}::text[]) AND m."direction" = 'OUTBOUND' AND m."sentAt" >= ${opts.cutoff} AND c."organizationId" = ${opts.organizationId}`),
    ]);
    for (const r of blasts) {
      const pending = r.status !== 'SENT';
      push({ email: r.key, at: pending || !r.sentAt ? opts.now : r.sentAt, pending, subject: r.subject, source: `Recruiter send “${r.name}”`, kind: 'send', from: r.fromEmail });
    }
    for (const j of jobs) push({ email: j.key, at: j.sentAt, pending: false, subject: j.subject, source: `Campaign “${j.name}”`, kind: 'campaign', from: j.fromEmail });
    for (const m of replies) {
      if (!m.sentAt) continue;
      // Every campaign email is also stored in the Inbox as an outbound message: that copy is not a manual reply.
      const copy = (out.get(m.key) ?? []).some((e) => e.kind !== 'reply' && norm(e.subject) === norm(m.subject ?? '') && Math.abs(e.at.getTime() - m.sentAt!.getTime()) <= REPLY_DUPLICATE_MS);
      if (!copy) push({ email: m.key, at: m.sentAt, pending: false, subject: m.subject ?? '', source: 'Inbox reply', kind: 'reply', from: m.senderEmail });
    }
  }
  return out;
}

/** The newest email per person, with how many there were. */
function latest(all: Map<string, Entry[]>): Map<string, RecentContact> {
  const out = new Map<string, RecentContact>();
  for (const [key, list] of all) {
    const top = list.reduce((a, b) => (b.at.getTime() > a.at.getTime() ? b : a));
    out.set(key, { ...top, count: list.length });
  }
  return out;
}

/**
 * Latest email per person (keyed by emailKey) inside the window. `excludeBlastId` is the send being prepared (never counts against itself).
 * mode 'plan' (default) is for the draft and Start; 'send' is the last check before a message goes out.
 */
export async function recentContacts(opts: { organizationId: string; emails: string[]; days: number; excludeBlastId: string; mode?: RecentMode; now?: Date }): Promise<Map<string, RecentContact>> {
  const days = repeatWindow(opts.days);
  if (days === 0 || !opts.emails.length) return new Map();
  const now = opts.now ?? new Date();
  const keys = [...new Set(opts.emails.map(emailKey))];
  const all = await collect({ organizationId: opts.organizationId, keys, cutoff: new Date(now.getTime() - days * DAY_MS), excludeBlastId: opts.excludeBlastId, mode: opts.mode ?? 'plan', now });
  return latest(all);
}

/** "Last emailed" for a screenful of people (Data, Contacts): the latest email that really went out in the last year, by emailKey. */
export async function lastEmailed(organizationId: string, emails: string[], now = new Date()): Promise<Map<string, RecentContact>> {
  if (!emails.length) return new Map();
  const keys = [...new Set(emails.map(emailKey))];
  return latest(await collect({ organizationId, keys, cutoff: new Date(now.getTime() - 365 * DAY_MS), mode: 'send', now }));
}

/** Everyone emailed in the last `days` days in this organisation (keyed by emailKey), for the "recently emailed" filter. A scan by date: use for a filter, not per row. */
export async function recentlyEmailedKeys(organizationId: string, days: number, now = new Date()): Promise<Map<string, { at: Date; subject: string; source: string }>> {
  const cutoff = new Date(now.getTime() - repeatWindow(days) * DAY_MS);
  const [blasts, jobs, replies] = await Promise.all([
    prisma.$queryRaw<{ key: string; sentAt: Date; subject: string; name: string }[]>(Prisma.sql`
      SELECT mailflow_email_key(r."email") AS key, r."sentAt", b."subject", b."name"
      FROM "RecruiterBlastRecipient" r JOIN "RecruiterBlast" b ON b."id" = r."blastId"
      WHERE r."status" = 'SENT' AND r."sentAt" >= ${cutoff} AND b."organizationId" = ${organizationId}`),
    prisma.$queryRaw<{ key: string; sentAt: Date; subject: string; name: string }[]>(Prisma.sql`
      SELECT mailflow_email_key(j."toEmail") AS key, j."sentAt", j."subject", c."name"
      FROM "EmailJob" j JOIN "Campaign" c ON c."id" = j."campaignId"
      WHERE j."status" = 'SENT' AND j."sentAt" >= ${cutoff} AND c."organizationId" = ${organizationId}`),
    prisma.$queryRaw<{ key: string; sentAt: Date; subject: string | null }[]>(Prisma.sql`
      SELECT mailflow_email_key(m."recipientEmail") AS key, m."sentAt", m."subject"
      FROM "ConversationMessage" m JOIN "Conversation" c ON c."id" = m."conversationId"
      WHERE m."direction" = 'OUTBOUND' AND m."sentAt" >= ${cutoff} AND c."organizationId" = ${organizationId}`),
  ]);
  const out = new Map<string, { at: Date; subject: string; source: string }>();
  const add = (key: string, at: Date, subject: string, source: string) => {
    const have = out.get(key);
    if (!have || at.getTime() > have.at.getTime()) out.set(key, { at, subject, source });
  };
  for (const r of blasts) add(r.key, r.sentAt, r.subject, `Recruiter send “${r.name}”`);
  for (const j of jobs) add(j.key, j.sentAt, j.subject, `Campaign “${j.name}”`);
  for (const m of replies) if (m.sentAt) add(m.key, m.sentAt, m.subject ?? '', 'Inbox reply');
  return out;
}

/* ---------------- cool-off ("do not contact until") ---------------- */

export interface CoolOff { until: Date; note: string | null }

/** People whose cool-off is still running, by emailKey (the latest end date when a person has several contact records). */
export async function coolOffs(organizationId: string, emails: string[], now = new Date()): Promise<Map<string, CoolOff>> {
  const out = new Map<string, CoolOff>();
  if (!emails.length) return out;
  const keys = [...new Set(emails.map(emailKey))];
  for (let i = 0; i < keys.length; i += CHUNK) {
    const rows = await prisma.$queryRaw<{ key: string; until: Date; note: string | null }[]>(Prisma.sql`
      SELECT mailflow_email_key("primaryEmail") AS key, "doNotContactUntil" AS until, "coolOffNote" AS note
      FROM "Contact"
      WHERE "organizationId" = ${organizationId} AND "doNotContactUntil" > ${now} AND mailflow_email_key("primaryEmail") = ANY(${keys.slice(i, i + CHUNK)}::text[])`);
    for (const r of rows) {
      const have = out.get(r.key);
      if (!have || r.until.getTime() > have.until.getTime()) out.set(r.key, { until: r.until, note: r.note });
    }
  }
  return out;
}

const shortDate = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

export function coolOffReason(c: CoolOff): string {
  const note = c.note?.trim();
  return `Do not contact until ${shortDate(c.until)}${note ? `: ${note.length > 90 ? `${note.slice(0, 87)}…` : note}` : ''}. Change it on the contact.`;
}

/* ---------------- wording ---------------- */

/** "Emailed 3 days ago (17 Nov): “Subject” from a@b.com · Recruiter send “Name”" — the reason shown for a skipped recruiter. */
export function repeatReason(c: RecentContact, now = new Date()): string {
  const subject = c.subject.length > 90 ? `${c.subject.slice(0, 87)}…` : c.subject;
  if (c.pending) return `Already in ${c.source}, going out soon: “${subject}”. Send again only if you mean to email them twice.`;
  const days = Math.floor((now.getTime() - c.at.getTime()) / DAY_MS);
  const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  const date = c.at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  const what = c.kind === 'reply' ? 'You replied' : 'Emailed';
  return `${what} ${when} (${date}): “${subject}”${c.from ? ` from ${c.from}` : ''} · ${c.source}${c.count > 1 ? ` · ${c.count} emails in the window` : ''}.`;
}
