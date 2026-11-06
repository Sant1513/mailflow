import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { QUICK_SEND_DESCRIPTION, QUICK_SEND_ON_APPROVAL } from '@/lib/quickSend/stats';

/**
 * One ledger of every email the organization sent, whatever sent it (Super Admin → Organization):
 *   CAMPAIGN     a campaign email (EmailJob)
 *   QUICK_SEND   a Quick Send email (an EmailJob of a Quick Send campaign)
 *   RECRUITER    a Recruiter Bulk Send message (one Gmail message: a Bcc group or a single copy)
 *   INBOX_REPLY  a reply written in MailFlow's inbox or straight in Gmail in a tracked thread
 * Every row knows who LAUNCHED it (the campaign/send creator, or the mailbox owner for inbox
 * replies) and which MAILBOX carried it, so sends from someone else's mailbox (backup /
 * fallback mailboxes, recruiter sends from teammates' mailboxes) are visible. "People" counts
 * every address on the message (To + Cc + Bcc).
 */
export type LedgerSource = 'CAMPAIGN' | 'QUICK_SEND' | 'RECRUITER' | 'INBOX_REPLY';
export const LEDGER_SOURCES: LedgerSource[] = ['CAMPAIGN', 'QUICK_SEND', 'RECRUITER', 'INBOX_REPLY'];

export interface LedgerFilter {
  organizationId: string;
  from: Date;
  to: Date;
  workspaceIds?: string[];
  userIds?: string[];
  accountIds?: string[];
  sources?: LedgerSource[];
  status?: 'SENT' | 'FAILED' | 'ALL';
  borrowedOnly?: boolean;
}

const QUICK = [QUICK_SEND_DESCRIPTION, QUICK_SEND_ON_APPROVAL];

/** The ledger as a SQL CTE (organization + time window), then the filters. */
function ledgerSql(f: LedgerFilter): Prisma.Sql {
  const conds: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (f.workspaceIds?.length) conds.push(Prisma.sql`l.ws = ANY(${f.workspaceIds}::text[])`);
  if (f.userIds?.length) conds.push(Prisma.sql`l.launched_by = ANY(${f.userIds}::text[])`);
  if (f.accountIds?.length) conds.push(Prisma.sql`l.account_id = ANY(${f.accountIds}::text[])`);
  if (f.sources?.length) conds.push(Prisma.sql`l.source = ANY(${f.sources}::text[])`);
  if (f.status === 'SENT') conds.push(Prisma.sql`l.sent = 1`);
  if (f.status === 'FAILED') conds.push(Prisma.sql`l.failed = 1`);
  if (f.borrowedOnly) conds.push(Prisma.sql`l.borrowed`);
  return Prisma.sql`
    WITH raw AS (
      SELECT CASE WHEN c."description" = ANY(${QUICK}::text[]) THEN 'QUICK_SEND' ELSE 'CAMPAIGN' END AS source,
             COALESCE(j."sentAt", j."lastAttemptAt") AS at, c."workspaceId" AS ws, c."createdById" AS launched_by,
             j."emailProviderAccountId" AS account_id,
             1 + COALESCE(array_length(j."ccEmails", 1), 0) + COALESCE(array_length(j."bccEmails", 1), 0) AS people,
             CASE WHEN j."status" = 'SENT' THEN 1 ELSE 0 END AS sent, CASE WHEN j."status" = 'FAILED' THEN 1 ELSE 0 END AS failed,
             c."id" AS ref_id, c."name" AS ref_name
      FROM "EmailJob" j JOIN "Campaign" c ON c."id" = j."campaignId"
      WHERE c."organizationId" = ${f.organizationId} AND j."status" IN ('SENT', 'FAILED')
        AND COALESCE(j."sentAt", j."lastAttemptAt") >= ${f.from} AND COALESCE(j."sentAt", j."lastAttemptAt") < ${f.to}
      UNION ALL
      SELECT 'RECRUITER', g."sentAt", b."workspaceId", b."createdById", g."accountId",
             g."recipientCount" + CASE WHEN b."mode" = 'BCC' THEN 1 ELSE 0 END + COALESCE(array_length(b."ccAddresses", 1), 0),
             CASE WHEN g."status" = 'SENT' THEN 1 ELSE 0 END, CASE WHEN g."status" = 'FAILED' THEN 1 ELSE 0 END,
             b."id", b."name"
      FROM "RecruiterBlastGroup" g JOIN "RecruiterBlast" b ON b."id" = g."blastId"
      WHERE b."organizationId" = ${f.organizationId} AND g."status" IN ('SENT', 'FAILED') AND g."recipientCount" > 0
        AND g."sentAt" >= ${f.from} AND g."sentAt" < ${f.to}
      UNION ALL
      SELECT 'INBOX_REPLY', m."sentAt", cv."workspaceId", a."userId", a."id",
             1 + COALESCE(array_length(m."cc", 1), 0) + COALESCE(array_length(m."bcc", 1), 0),
             1, 0, cv."id", cv."subject"
      FROM "ConversationMessage" m
      JOIN "Conversation" cv ON cv."id" = m."conversationId"
      LEFT JOIN "EmailProviderAccount" a ON a."id" = cv."emailProviderAccountId"
      WHERE cv."organizationId" = ${f.organizationId} AND m."direction" = 'OUTBOUND' AND m."status" = 'SENT'
        AND m."sentAt" >= ${f.from} AND m."sentAt" < ${f.to}
        -- campaign emails are also stored in their conversation; count them once, as campaign emails
        AND NOT EXISTS (SELECT 1 FROM "EmailJob" ej WHERE ej."gmailMessageId" = m."gmailMessageId")
    ),
    l AS (
      SELECT raw.*, acc."userId" AS owner_id,
             (raw.account_id IS NOT NULL AND acc."userId" IS DISTINCT FROM raw.launched_by) AS borrowed
      FROM raw LEFT JOIN "EmailProviderAccount" acc ON acc."id" = raw.account_id
    ),
    f AS (SELECT * FROM l WHERE ${Prisma.join(conds, ' AND ')})`;
}

const n = (v: unknown) => Number(v ?? 0);

export interface LedgerReport {
  totals: { emails: number; people: number; failed: number; borrowed: number; senders: number; mailboxes: number; replies: number; replyRate: number | null };
  bySource: { source: LedgerSource; emails: number; people: number; failed: number; borrowed: number }[];
  byDay: { day: string; source: LedgerSource; emails: number }[];
  byUser: {
    userId: string; name: string; email: string; workspace: string | null;
    emails: number; people: number; failed: number; bySource: Record<LedgerSource, number>;
    fromOwnMailbox: number; fromOthersMailboxes: number; othersUsedTheirMailbox: number; replies: number; lastAt: string | null;
  }[];
  byMailbox: { accountId: string; emailAddress: string; ownerName: string | null; emails: number; people: number; byOwner: number; byOthers: number; senders: { userId: string; name: string; emails: number }[] }[];
  borrowedPairs: { launchedBy: string; launchedByName: string; owner: string; ownerName: string; mailbox: string; emails: number; people: number }[];
  sends: { source: LedgerSource; refId: string; name: string; launchedBy: string; launchedByName: string; workspace: string | null; mailboxes: string[]; emails: number; people: number; failed: number; replies: number; firstAt: string; lastAt: string; borrowed: boolean }[];
}

/** Every number on the Organization "Everything sent" section, for one set of filters. */
export async function ledgerReport(f: LedgerFilter): Promise<LedgerReport> {
  const L = ledgerSql(f);
  const [totals, bySource, byDay, byUser, byOwner, byMailbox, pairs, sends] = await Promise.all([
    prisma.$queryRaw<any[]>`${L} SELECT COALESCE(SUM(sent),0) emails, COALESCE(SUM(CASE WHEN sent = 1 THEN people END),0) people, COALESCE(SUM(failed),0) failed,
      COALESCE(SUM(CASE WHEN borrowed AND sent = 1 THEN 1 END),0) borrowed, COUNT(DISTINCT launched_by) senders, COUNT(DISTINCT account_id) mailboxes FROM f`,
    prisma.$queryRaw<any[]>`${L} SELECT source, SUM(sent) emails, SUM(CASE WHEN sent = 1 THEN people ELSE 0 END) people, SUM(failed) failed, SUM(CASE WHEN borrowed AND sent = 1 THEN 1 ELSE 0 END) borrowed FROM f GROUP BY source`,
    prisma.$queryRaw<any[]>`${L} SELECT to_char((at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, source, SUM(sent) emails FROM f GROUP BY 1, 2 ORDER BY 1`,
    prisma.$queryRaw<any[]>`${L} SELECT launched_by, source, SUM(sent) emails, SUM(CASE WHEN sent = 1 THEN people ELSE 0 END) people, SUM(failed) failed,
      SUM(CASE WHEN borrowed AND sent = 1 THEN 1 ELSE 0 END) borrowed, SUM(CASE WHEN NOT borrowed AND sent = 1 THEN 1 ELSE 0 END) own, MAX(at) last_at FROM f WHERE launched_by IS NOT NULL GROUP BY launched_by, source`,
    prisma.$queryRaw<any[]>`${L} SELECT owner_id, SUM(sent) emails FROM f WHERE borrowed AND owner_id IS NOT NULL GROUP BY owner_id`,
    prisma.$queryRaw<any[]>`${L} SELECT account_id, launched_by, owner_id, SUM(sent) emails, SUM(CASE WHEN sent = 1 THEN people ELSE 0 END) people FROM f WHERE account_id IS NOT NULL GROUP BY account_id, launched_by, owner_id`,
    prisma.$queryRaw<any[]>`${L} SELECT launched_by, owner_id, account_id, SUM(sent) emails, SUM(CASE WHEN sent = 1 THEN people ELSE 0 END) people FROM f WHERE borrowed GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 100`,
    prisma.$queryRaw<any[]>`${L} SELECT source, ref_id, MAX(ref_name) ref_name, launched_by, MAX(ws) ws, array_agg(DISTINCT account_id) FILTER (WHERE account_id IS NOT NULL) accounts,
      SUM(sent) emails, SUM(CASE WHEN sent = 1 THEN people ELSE 0 END) people, SUM(failed) failed, MIN(at) first_at, MAX(at) last_at, BOOL_OR(borrowed) borrowed
      FROM f WHERE source <> 'INBOX_REPLY' GROUP BY source, ref_id, launched_by ORDER BY MAX(at) DESC LIMIT 200`,
  ]);

  // Names for everyone and every mailbox mentioned.
  const userIds = new Set<string>();
  const accountIds = new Set<string>();
  const wsIds = new Set<string>();
  for (const r of [...byUser, ...byOwner, ...byMailbox, ...pairs, ...sends]) {
    if (r.launched_by) userIds.add(r.launched_by);
    if (r.owner_id) userIds.add(r.owner_id);
    if (r.account_id) accountIds.add(r.account_id);
    if (r.ws) wsIds.add(r.ws);
    for (const a of r.accounts ?? []) accountIds.add(a);
  }
  const [users, accounts, workspaces] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true, email: true, ownedWorkspaces: { select: { name: true }, take: 1 } } }),
    prisma.emailProviderAccount.findMany({ where: { id: { in: [...accountIds] } }, select: { id: true, emailAddress: true, userId: true } }),
    prisma.workspace.findMany({ where: { id: { in: [...wsIds] } }, select: { id: true, name: true } }),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const wsById = new Map(workspaces.map((w) => [w.id, w.name]));
  const nameOf = (id: string | null) => (id ? userById.get(id)?.name || userById.get(id)?.email || 'Unknown user' : 'Unknown');

  // Replies (human) in the window: per conversation owner, per recruiter send, per campaign.
  const replyConds: Prisma.Sql[] = [Prisma.sql`cv."organizationId" = ${f.organizationId}`, Prisma.sql`m."direction" = 'INBOUND'`, Prisma.sql`m."classification" = 'HUMAN_REPLY'`, Prisma.sql`m."receivedAt" >= ${f.from}`, Prisma.sql`m."receivedAt" < ${f.to}`];
  if (f.workspaceIds?.length) replyConds.push(Prisma.sql`cv."workspaceId" = ANY(${f.workspaceIds}::text[])`);
  if (f.userIds?.length) replyConds.push(Prisma.sql`cv."ownerId" = ANY(${f.userIds}::text[])`);
  if (f.accountIds?.length) replyConds.push(Prisma.sql`cv."emailProviderAccountId" = ANY(${f.accountIds}::text[])`);
  // Replies follow the type and "someone else's mailbox" filters too: recruiter replies live in
  // conversations tied to a recruiter send; "borrowed" means the mailbox isn't the owner's own.
  if (f.sources?.length) {
    const recruiter = f.sources.includes('RECRUITER');
    const other = f.sources.some((s) => s !== 'RECRUITER');
    if (recruiter && !other) replyConds.push(Prisma.sql`cv."recruiterBlastId" IS NOT NULL`);
    if (other && !recruiter) replyConds.push(Prisma.sql`cv."recruiterBlastId" IS NULL`);
  }
  if (f.borrowedOnly) {
    replyConds.push(Prisma.sql`EXISTS (SELECT 1 FROM "EmailProviderAccount" ra WHERE ra."id" = cv."emailProviderAccountId" AND ra."userId" IS DISTINCT FROM cv."ownerId")`);
  }
  if (f.status === 'FAILED') replyConds.push(Prisma.sql`FALSE`);
  const repliesByOwner = await prisma.$queryRaw<any[]>`
    SELECT cv."ownerId" owner, COUNT(*) replies FROM "ConversationMessage" m JOIN "Conversation" cv ON cv."id" = m."conversationId"
    WHERE ${Prisma.join(replyConds, ' AND ')} GROUP BY 1`;
  const repliesTotal = repliesByOwner.reduce((s, r) => s + n(r.replies), 0);
  const replyByOwner = new Map(repliesByOwner.map((r) => [r.owner as string, n(r.replies)]));

  const recruiterIds = sends.filter((s) => s.source === 'RECRUITER').map((s) => s.ref_id as string);
  const campaignIds = sends.filter((s) => s.source !== 'RECRUITER').map((s) => s.ref_id as string);
  const [recruiterReplies, campaignReplies] = await Promise.all([
    recruiterIds.length
      ? prisma.$queryRaw<any[]>`SELECT "blastId" id, COUNT(*) n FROM "RecruiterBlastRecipient" WHERE "blastId" = ANY(${recruiterIds}::text[]) AND "repliedAt" IS NOT NULL GROUP BY 1`
      : Promise.resolve([]),
    campaignIds.length
      ? prisma.$queryRaw<any[]>`SELECT j."campaignId" id, COUNT(DISTINCT cv."id") n FROM "EmailJob" j
          JOIN "Conversation" cv ON cv."gmailThreadId" = j."gmailThreadId" AND cv."emailProviderAccountId" = j."emailProviderAccountId"
          WHERE j."campaignId" = ANY(${campaignIds}::text[]) AND EXISTS (SELECT 1 FROM "ConversationMessage" m WHERE m."conversationId" = cv."id" AND m."direction" = 'INBOUND' AND m."classification" = 'HUMAN_REPLY')
          GROUP BY 1`
      : Promise.resolve([]),
  ]);
  const repliesByRef = new Map([...recruiterReplies, ...campaignReplies].map((r) => [r.id as string, n(r.n)]));

  const t = totals[0] ?? {};
  const emails = n(t.emails);
  const empty = (): Record<LedgerSource, number> => ({ CAMPAIGN: 0, QUICK_SEND: 0, RECRUITER: 0, INBOX_REPLY: 0 });

  // Per user.
  const perUser = new Map<string, LedgerReport['byUser'][number]>();
  for (const r of byUser) {
    const id = r.launched_by as string;
    const u = userById.get(id);
    const row = perUser.get(id) ?? { userId: id, name: u?.name || u?.email || 'Unknown user', email: u?.email ?? '', workspace: u?.ownedWorkspaces[0]?.name ?? null, emails: 0, people: 0, failed: 0, bySource: empty(), fromOwnMailbox: 0, fromOthersMailboxes: 0, othersUsedTheirMailbox: 0, replies: replyByOwner.get(id) ?? 0, lastAt: null };
    row.emails += n(r.emails); row.people += n(r.people); row.failed += n(r.failed);
    row.bySource[r.source as LedgerSource] += n(r.emails);
    row.fromOwnMailbox += n(r.own); row.fromOthersMailboxes += n(r.borrowed);
    const last = r.last_at ? new Date(r.last_at).toISOString() : null;
    if (last && (!row.lastAt || last > row.lastAt)) row.lastAt = last;
    perUser.set(id, row);
  }
  for (const r of byOwner) {
    const id = r.owner_id as string;
    const existing = perUser.get(id);
    if (existing) existing.othersUsedTheirMailbox = n(r.emails);
    else {
      const u = userById.get(id);
      perUser.set(id, { userId: id, name: u?.name || u?.email || 'Unknown user', email: u?.email ?? '', workspace: u?.ownedWorkspaces[0]?.name ?? null, emails: 0, people: 0, failed: 0, bySource: empty(), fromOwnMailbox: 0, fromOthersMailboxes: 0, othersUsedTheirMailbox: n(r.emails), replies: replyByOwner.get(id) ?? 0, lastAt: null });
    }
  }

  // Per mailbox.
  const perMailbox = new Map<string, LedgerReport['byMailbox'][number]>();
  for (const r of byMailbox) {
    const acc = accountById.get(r.account_id);
    const row: LedgerReport['byMailbox'][number] = perMailbox.get(r.account_id) ?? { accountId: r.account_id, emailAddress: acc?.emailAddress ?? 'Unknown mailbox', ownerName: acc ? nameOf(acc.userId) : null, emails: 0, people: 0, byOwner: 0, byOthers: 0, senders: [] };
    row.emails += n(r.emails); row.people += n(r.people);
    if (r.launched_by && r.launched_by === r.owner_id) row.byOwner += n(r.emails); else row.byOthers += n(r.emails);
    if (r.launched_by) row.senders.push({ userId: r.launched_by, name: nameOf(r.launched_by), emails: n(r.emails) });
    perMailbox.set(r.account_id, row);
  }

  return {
    totals: { emails, people: n(t.people), failed: n(t.failed), borrowed: n(t.borrowed), senders: n(t.senders), mailboxes: n(t.mailboxes), replies: repliesTotal, replyRate: emails ? Math.round((repliesTotal / emails) * 1000) / 10 : null },
    bySource: LEDGER_SOURCES.map((s) => {
      const r = bySource.find((x) => x.source === s);
      return { source: s, emails: n(r?.emails), people: n(r?.people), failed: n(r?.failed), borrowed: n(r?.borrowed) };
    }),
    byDay: byDay.map((r) => ({ day: r.day as string, source: r.source as LedgerSource, emails: n(r.emails) })),
    byUser: [...perUser.values()].sort((a, b) => b.emails - a.emails || b.othersUsedTheirMailbox - a.othersUsedTheirMailbox),
    byMailbox: [...perMailbox.values()].map((m) => ({ ...m, senders: m.senders.sort((a, b) => b.emails - a.emails) })).sort((a, b) => b.emails - a.emails),
    borrowedPairs: pairs.map((r) => ({ launchedBy: r.launched_by, launchedByName: nameOf(r.launched_by), owner: r.owner_id, ownerName: nameOf(r.owner_id), mailbox: accountById.get(r.account_id)?.emailAddress ?? '', emails: n(r.emails), people: n(r.people) })),
    sends: sends.map((r) => ({
      source: r.source as LedgerSource, refId: r.ref_id, name: r.ref_name ?? '(untitled)', launchedBy: r.launched_by, launchedByName: nameOf(r.launched_by),
      workspace: wsById.get(r.ws) ?? null, mailboxes: ((r.accounts ?? []) as string[]).map((a) => accountById.get(a)?.emailAddress ?? '').filter(Boolean),
      emails: n(r.emails), people: n(r.people), failed: n(r.failed), replies: repliesByRef.get(r.ref_id) ?? 0,
      firstAt: new Date(r.first_at).toISOString(), lastAt: new Date(r.last_at).toISOString(), borrowed: !!r.borrowed,
    })),
  };
}

/** What the filters can choose from. */
export async function ledgerOptions(organizationId: string) {
  const [workspaces, users, mailboxes] = await Promise.all([
    prisma.workspace.findMany({ where: { organizationId }, select: { id: true, name: true, owner: { select: { name: true } } }, orderBy: { name: 'asc' } }),
    prisma.user.findMany({ where: { organizationId }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } }),
    prisma.emailProviderAccount.findMany({ where: { organizationId }, select: { id: true, emailAddress: true, status: true }, orderBy: { emailAddress: 'asc' } }),
  ]);
  return {
    workspaces: workspaces.map((w) => ({ id: w.id, name: w.owner?.name ? `${w.name} (${w.owner.name})` : w.name })),
    users: users.map((u) => ({ id: u.id, name: u.name || u.email, email: u.email })),
    mailboxes: mailboxes.map((m) => ({ id: m.id, name: m.emailAddress, status: m.status })),
  };
}
