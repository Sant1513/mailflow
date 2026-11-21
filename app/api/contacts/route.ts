import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId } from '@/lib/permissions/workspace';
import { pageInfo, parsePaging } from '@/lib/api/paging';
import { lastEmailed, recentlyEmailedKeys } from '@/lib/recruiterSend/recent';
import { emailKey } from '@/lib/recruiterSend/emailKey';
import { emailedCondition, likeContains, parseEmailedFilter, toLastEmailedInfo } from '@/lib/contacts/recentEmailed';

/**
 * Contacts of the workspace, newest activity first: ?q= search, ?page=&pageSize= paging, with the total.
 * ?emailed=within|not&emailedDays=3|7|10|30 keeps people emailed (or not emailed) from MailFlow in the last N days:
 * the set of recently emailed people is one date-range scan (recentlyEmailedKeys), and the contact list is then
 * filtered in the database on mailflow_email_key("primaryEmail") (indexed), so counts and pages stay exact.
 * Each contact also carries lastEmailed (looked up for this page only).
 */
export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));
  const q = url.searchParams.get('q')?.trim();
  const paging = parsePaging(url.searchParams, { pageSize: 50 });
  const emailed = parseEmailedFilter(url.searchParams);

  const where = {
    workspaceId,
    ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { primaryEmail: { contains: q, mode: 'insensitive' as const } }] } : {}),
  };

  const keys = emailed.mode === 'any' ? [] : [...(await recentlyEmailedKeys(session.organizationId, emailed.days)).keys()];
  const cond = emailedCondition(Prisma.sql`"primaryEmail"`, emailed.mode, keys);

  let contacts;
  let total: number;
  if (!cond) {
    [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: paging.skip,
        take: paging.take,
        include: { _count: { select: { records: true, conversations: true } } },
      }),
      prisma.contact.count({ where }),
    ]);
  } else {
    const like = q ? likeContains(q) : null;
    const search = like ? Prisma.sql`AND ("name" ILIKE ${like} OR "primaryEmail" ILIKE ${like})` : Prisma.empty;
    const base = Prisma.sql`FROM "Contact" WHERE "workspaceId" = ${workspaceId} ${search} AND ${cond}`;
    const [ids, counted] = await Promise.all([
      prisma.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" ${base} ORDER BY "updatedAt" DESC, "id" ASC OFFSET ${paging.skip} LIMIT ${paging.take}`),
      prisma.$queryRaw<{ n: bigint | number }[]>(Prisma.sql`SELECT count(*) AS n ${base}`),
    ]);
    total = Number(counted[0]?.n ?? 0);
    const rows = ids.length
      ? await prisma.contact.findMany({ where: { id: { in: ids.map((r) => r.id) } }, include: { _count: { select: { records: true, conversations: true } } } })
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    contacts = ids.map((r) => byId.get(r.id)).filter((r): r is NonNullable<typeof r> => !!r);
  }

  const last = await lastEmailed(session.organizationId, contacts.map((c) => c.primaryEmail));
  const withLast = contacts.map((c) => ({ ...c, lastEmailed: toLastEmailedInfo(last.get(emailKey(c.primaryEmail))) }));

  return NextResponse.json({ contacts: withLast, ...pageInfo(total, paging) });
});
