import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { ledgerReport, type LedgerReport, type LedgerSource } from '@/lib/analytics/sendLedger';

/**
 * The daily report (8 PM IST, Monday to Friday): everything sent since the last report, by
 * type, by user and by mailbox (the Organization ledger), plus each person's inbox: replies
 * received, still pending, closed, and first / average response times for the window and the
 * last 30 days. Rows where every number is 0 are left out.
 *
 * The window runs 8 PM to 8 PM. Work after 8 PM goes into the next working day's report, and
 * Monday's report also carries Friday after 8 PM, Saturday and Sunday — each shown as its own
 * line ("segments") so it's clear what came from outside the day.
 */

export const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 864e5;
const NOISE = ['BOUNCE', 'DELIVERY_FAILURE', 'OUT_OF_OFFICE', 'AUTO_REPLY'];

/** The hour the daily report is cut and sent (IST). */
export const REPORT_HOUR = 20;
const ymdOf = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const istHour = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).getUTCHours();
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekday = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0 Sunday … 6 Saturday
const midnight = (ymd: string) => new Date(`${ymd}T00:00:00+05:30`);
const cutoff = (ymd: string) => new Date(`${ymd}T${String(REPORT_HOUR).padStart(2, '0')}:00:00+05:30`);
const dayName = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' });

export interface ReportWindow {
  /** daily = 8 PM → 8 PM (after-hours lines are remarks); weekly = Monday → Sunday, day by day. */
  kind?: 'daily' | 'weekly';
  /** The working day the report is for (YYYY-MM-DD, IST); for a week, its Sunday. */
  day: string;
  from: Date;
  to: Date;
  /** The parts of the window: after-hours / weekend first, then the day itself (main). */
  segments: { label: string; from: Date; to: Date; main: boolean }[];
}

/** 8 PM of the previous working day → 8 PM of `day`; Monday reaches back to Friday 8 PM. */
export function reportWindow(day: string): ReportWindow {
  const monday = weekday(day) === 1;
  const prev = addDays(day, monday ? -3 : -1);
  const from = cutoff(prev);
  const to = cutoff(day);
  const segments: ReportWindow['segments'] = monday
    ? [
        { label: 'Friday after 8 PM', from, to: midnight(addDays(day, -2)), main: false },
        { label: 'Saturday', from: midnight(addDays(day, -2)), to: midnight(addDays(day, -1)), main: false },
        { label: 'Sunday', from: midnight(addDays(day, -1)), to: midnight(day), main: false },
      ]
    : [{ label: `${dayName(prev)} after 8 PM`, from, to: midnight(day), main: false }];
  segments.push({ label: `${dayName(day)} until 8 PM`, from: midnight(day), to, main: true });
  return { day, from, to, segments };
}

/**
 * The week before `now`'s week: Monday 00:00 → Monday 00:00 IST, one line per day (the
 * Monday-morning weekly report).
 */
export function weekWindow(now: Date): ReportWindow {
  const today = ymdOf(now);
  const thisMonday = addDays(today, -((weekday(today) + 6) % 7));
  const start = addDays(thisMonday, -7);
  const fmt = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const segments = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(start, i);
    return { label: fmt(d), from: midnight(d), to: midnight(addDays(d, 1)), main: true };
  });
  return { kind: 'weekly', day: addDays(start, 6), from: midnight(start), to: midnight(thisMonday), segments };
}

/**
 * The report due at `now`: a working day whose 8 PM has passed — until 8 AM the next morning,
 * so a late run still catches up — or null (weekends, or before 8 PM).
 */
export function dueReportDay(now: Date): string | null {
  const today = ymdOf(now);
  const hour = istHour(now);
  const day = hour >= REPORT_HOUR ? today : hour < 8 ? addDays(today, -1) : null;
  if (!day) return null;
  const wd = weekday(day);
  return wd === 0 || wd === 6 ? null : day;
}

/** The working day before `day` (Monday → Friday), for "last report" previews. */
export function previousWorkingDay(day: string): string {
  let d = addDays(day, -1);
  while ([0, 6].includes(weekday(d))) d = addDays(d, -1);
  return d;
}

/** The latest report day at or before `now` whose 8 PM has passed (for previews and tests). */
export function latestReportDay(now: Date): string {
  const due = dueReportDay(now);
  if (due) return due;
  const today = ymdOf(now);
  return [0, 6].includes(weekday(today)) || istHour(now) < REPORT_HOUR ? previousWorkingDay(today) : today;
}

/** The IST day before `now`: [from, to) as instants, and its YYYY-MM-DD. */
export function previousIstDay(now: Date): { from: Date; to: Date; ymd: string } {
  const istMidnight = Math.floor((now.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  const from = new Date(istMidnight - DAY_MS);
  return { from, to: new Date(istMidnight), ymd: new Date(from.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10) };
}

export interface InboxRow {
  userId: string | null;
  name: string;
  email: string;
  image: string | null;
  received: number;
  pending: number;
  closed: number;
  frtDay: number | null;
  artDay: number | null;
  frt30: number | null;
  art30: number | null;
}

export interface SegmentCount { label: string; main: boolean; emails: number; people: number; replies: number }

export interface DailyActivity {
  kind: 'daily' | 'weekly';
  from: Date;
  to: Date;
  /** Weekly: the week before, for "vs last week". */
  previous: { emails: number; people: number; replies: number } | null;
  /** The report day (YYYY-MM-DD, IST). */
  ymd: string;
  /** What the window is made of, with counts per part (after-hours / weekend / the day). */
  segments: SegmentCount[];
  totals: LedgerReport['totals'];
  bySource: LedgerReport['bySource'];
  users: (LedgerReport['byUser'][number] & { image: string | null })[];
  pairs: LedgerReport['borrowedPairs'];
  inbox: InboxRow[];
  inboxTotal: Omit<InboxRow, 'userId' | 'name' | 'email' | 'image'>;
}

export function hasActivity(a: DailyActivity): boolean {
  return a.totals.emails > 0 || a.inboxTotal.received > 0 || a.inboxTotal.closed > 0;
}

interface Msg { cid: string; uid: string | null; created: Date; dir: string; at: Date }

const avg = (v: number[]) => (v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null);

/**
 * Response times from one conversation's messages (oldest first, auto-replies/bounces left out).
 * FRT: the first student/recruiter message → the first answer after it (a campaign email sent
 * before the reply does not count as an answer). ART: each run of incoming messages → the answer.
 * Only answers inside [from, to) count; FRT only for conversations whose first answer is there.
 */
export function responseTimes(msgs: { dir: string; at: Date }[], from: Date, to: Date): { frt: number | null; art: number[] } {
  let frt: number | null = null;
  const art: number[] = [];
  let firstIn: Date | null = null;
  let answered = false;
  let waitingSince: Date | null = null;
  for (const m of msgs) {
    if (m.dir === 'INBOUND') {
      firstIn ??= m.at;
      waitingSince ??= m.at;
    } else if (m.dir === 'OUTBOUND' && waitingSince) {
      const inWindow = m.at >= from && m.at < to;
      const minutes = (m.at.getTime() - waitingSince.getTime()) / 60_000;
      if (inWindow && minutes >= 0) art.push(minutes);
      if (!answered && firstIn && inWindow) frt = (m.at.getTime() - firstIn.getTime()) / 60_000;
      answered = true;
      waitingSince = null;
    }
  }
  return { frt, art };
}

export async function collectDailyActivity(organizationId: string, window: ReportWindow): Promise<DailyActivity> {
  const { from, to, day: ymd } = window;
  const from30 = new Date(to.getTime() - 30 * DAY_MS);
  const noise = Prisma.sql`m."classification"::text <> ALL(${NOISE}::text[])`;

  const [ledger, msgs, pendingRows, closedRows] = await Promise.all([
    ledgerReport({ organizationId, from, to }),
    // Every conversation message of the last 30 days (oldest first), for received counts and response times.
    prisma.$queryRaw<Msg[]>`
      SELECT m."conversationId" AS cid, c."assigneeId" AS uid, c."createdAt" AS created, m."direction"::text AS dir,
             COALESCE(m."receivedAt", m."sentAt") AS at
      FROM "ConversationMessage" m JOIN "Conversation" c ON c."id" = m."conversationId"
      WHERE c."organizationId" = ${organizationId} AND ${noise}
        AND COALESCE(m."receivedAt", m."sentAt") >= ${from30} AND COALESCE(m."receivedAt", m."sentAt") < ${to}
      ORDER BY m."conversationId", COALESCE(m."receivedAt", m."sentAt")`,
    // Waiting for an answer right now: open, and the latest real message is theirs.
    prisma.$queryRaw<{ uid: string | null; n: bigint }[]>`
      SELECT c."assigneeId" AS uid, COUNT(*) AS n
      FROM "Conversation" c
      WHERE c."organizationId" = ${organizationId} AND c."status" IN ('OPEN', 'IN_PROGRESS')
        AND (SELECT m."direction"::text FROM "ConversationMessage" m
             WHERE m."conversationId" = c."id" AND ${noise}
             ORDER BY COALESCE(m."receivedAt", m."sentAt") DESC NULLS LAST LIMIT 1) = 'INBOUND'
      GROUP BY 1`,
    // Closed (resolved/closed) during the day, credited to the person the conversation is assigned to.
    prisma.$queryRaw<{ uid: string | null; n: bigint }[]>`
      SELECT COALESCE(c."assigneeId", a."actorId") AS uid, COUNT(DISTINCT a."targetId") AS n
      FROM "AuditLog" a LEFT JOIN "Conversation" c ON c."id" = a."targetId"
      WHERE a."organizationId" = ${organizationId} AND a."action" = 'CONVERSATION_STATUS_CHANGE'
        AND a."metadata"->>'to' IN ('RESOLVED', 'CLOSED') AND a."createdAt" >= ${from} AND a."createdAt" < ${to}
      GROUP BY 1`,
  ]);

  // Per person: received (incoming on the day), response times (day and 30 days).
  type Acc = { received: number; frtDay: number[]; artDay: number[]; frt30: number[]; art30: number[] };
  const acc = new Map<string, Acc>();
  const get = (uid: string | null) => {
    const k = uid ?? '';
    let a = acc.get(k);
    if (!a) acc.set(k, (a = { received: 0, frtDay: [], artDay: [], frt30: [], art30: [] }));
    return a;
  };
  const all = { frtDay: [] as number[], artDay: [] as number[], frt30: [] as number[], art30: [] as number[] };
  for (let i = 0; i < msgs.length; ) {
    let j = i;
    while (j < msgs.length && msgs[j]!.cid === msgs[i]!.cid) j++;
    const conv = msgs.slice(i, j);
    const a = get(conv[0]!.uid);
    for (const m of conv) if (m.dir === 'INBOUND' && m.at >= from && m.at < to) a.received++;
    const day = responseTimes(conv, from, to);
    // FRT over 30 days only for conversations that started in the window (their first message is in it).
    const month = responseTimes(conv, from30, to);
    if (day.frt !== null) { a.frtDay.push(day.frt); all.frtDay.push(day.frt); }
    a.artDay.push(...day.art); all.artDay.push(...day.art);
    if (month.frt !== null && conv[0]!.created >= from30) { a.frt30.push(month.frt); all.frt30.push(month.frt); }
    a.art30.push(...month.art); all.art30.push(...month.art);
    i = j;
  }
  const pending = new Map(pendingRows.map((r) => [r.uid ?? '', Number(r.n)]));
  const closed = new Map(closedRows.map((r) => [r.uid ?? '', Number(r.n)]));

  const ids = new Set<string>([...acc.keys(), ...pending.keys(), ...closed.keys(), ...ledger.byUser.map((u) => u.userId)]);
  ids.delete('');
  const people = await prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, email: true, image: true } });
  const person = new Map(people.map((p) => [p.id, p]));

  const keys = new Set<string>([...acc.keys(), ...pending.keys(), ...closed.keys()]);
  const inbox: InboxRow[] = [...keys]
    .map((k) => {
      const a = acc.get(k);
      const p = k ? person.get(k) : undefined;
      return {
        userId: k || null,
        name: k ? p?.name || p?.email || 'Unknown user' : 'Not assigned',
        email: p?.email ?? '',
        image: p?.image ?? null,
        received: a?.received ?? 0,
        pending: pending.get(k) ?? 0,
        closed: closed.get(k) ?? 0,
        frtDay: avg(a?.frtDay ?? []),
        artDay: avg(a?.artDay ?? []),
        frt30: avg(a?.frt30 ?? []),
        art30: avg(a?.art30 ?? []),
      };
    })
    // Only people with something on the day (received, pending, closed or an answer).
    .filter((r) => r.received || r.pending || r.closed || r.frtDay !== null || r.artDay !== null)
    .sort((x, y) => y.received - x.received || y.pending - x.pending || x.name.localeCompare(y.name));

  const inboxTotal = {
    received: inbox.reduce((n, r) => n + r.received, 0),
    pending: inbox.reduce((n, r) => n + r.pending, 0),
    closed: inbox.reduce((n, r) => n + r.closed, 0),
    frtDay: avg(all.frtDay),
    artDay: avg(all.artDay),
    frt30: avg(all.frt30),
    art30: avg(all.art30),
  };

  // Each part of the window on its own line: emails and people sent, replies received.
  const segments = await Promise.all(
    window.segments.map(async (seg) => {
      const part = await ledgerReport({ organizationId, from: seg.from, to: seg.to });
      const replies = msgs.filter((m) => m.dir === 'INBOUND' && m.at >= seg.from && m.at < seg.to).length;
      return { label: seg.label, main: seg.main, emails: part.totals.emails, people: part.totals.people, replies };
    }),
  );

  // A week is compared with the week before (same length, just before it).
  let previous: DailyActivity['previous'] = null;
  if (window.kind === 'weekly') {
    const span = to.getTime() - from.getTime();
    const pFrom = new Date(from.getTime() - span);
    const before = await ledgerReport({ organizationId, from: pFrom, to: from });
    const [r] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "ConversationMessage" m JOIN "Conversation" c ON c."id" = m."conversationId"
      WHERE c."organizationId" = ${organizationId} AND m."direction"::text = 'INBOUND' AND ${noise}
        AND COALESCE(m."receivedAt", m."sentAt") >= ${pFrom} AND COALESCE(m."receivedAt", m."sentAt") < ${from}`;
    previous = { emails: before.totals.emails, people: before.totals.people, replies: Number(r?.n ?? 0) };
  }

  const users = ledger.byUser
    .filter((u) => u.emails || u.people || u.othersUsedTheirMailbox || u.replies || u.failed)
    .map((u) => ({ ...u, image: person.get(u.userId)?.image ?? null }));

  return {
    kind: window.kind ?? 'daily',
    from,
    to,
    previous,
    ymd,
    segments,
    totals: ledger.totals,
    bySource: ledger.bySource.filter((s) => s.emails > 0),
    users,
    pairs: ledger.borrowedPairs,
    inbox,
    inboxTotal,
  };
}

export const SOURCE_LABEL: Record<LedgerSource, string> = { CAMPAIGN: 'Campaigns', QUICK_SEND: 'Quick Send', RECRUITER: 'Recruiter Bulk Send', INBOX_REPLY: 'Inbox replies' };
export const SOURCE_COLOR: Record<LedgerSource, string> = { CAMPAIGN: '#ED0331', QUICK_SEND: '#F97316', RECRUITER: '#8B5CF6', INBOX_REPLY: '#0EA5E9' };
