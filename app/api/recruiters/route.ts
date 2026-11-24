import { NextResponse } from 'next/server';
import { Prisma, Role } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { pageInfo, parsePaging } from '@/lib/api/paging';
import { blastScope } from '@/lib/orgs/scope';

export const dynamic = 'force-dynamic';

/**
 * The people emailed through Recruiter Bulk Send, one line per address: when they were last emailed, how many emails and
 * sends, and the last outcome. They are not saved as contacts (that would copy tens of thousands of rows), so the Contacts
 * page lists them from here. Admins see their organisation's recruiters, a Super Admin every organisation's.
 */
export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  if (!blastScope(session)) return NextResponse.json({ error: 'Admins only' }, { status: 403 });
  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim().slice(0, 100) ?? '';
  const paging = parsePaging(url.searchParams, { pageSize: 50 });
  // LIKE wildcards in what was typed are literals: escape \ % _ so "a_b" does not match "axb" and "%" does not match everything.
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%` : null;

  const conditions: Prisma.Sql[] = [Prisma.sql`b."organizationId" = ${session.organizationId}`];
  if (session.role !== Role.SUPER_ADMIN) conditions.push(Prisma.sql`b."orgUnitId" = ${session.orgUnitId}`);
  const org = url.searchParams.get('org')?.trim();
  if (org && session.role === Role.SUPER_ADMIN) conditions.push(Prisma.sql`b."orgUnitId" = ${org}`);
  if (like) conditions.push(Prisma.sql`(r."email" ILIKE ${like} OR r."name" ILIKE ${like})`);
  const where = Prisma.join(conditions, ' AND ');

  const [rows, totalRows] = await Promise.all([
    prisma.$queryRaw<{ email: string; name: string | null; lastSentAt: Date | null; sends: number; blasts: number; lastStatus: string }[]>(Prisma.sql`
      SELECT lower(r."email") AS email,
             (array_agg(r."name" ORDER BY r."sentAt" DESC NULLS LAST) FILTER (WHERE r."name" IS NOT NULL))[1] AS name,
             max(r."sentAt") AS "lastSentAt",
             (count(*) FILTER (WHERE r."status" = 'SENT'))::int AS sends,
             count(DISTINCT r."blastId")::int AS blasts,
             (array_agg(r."status" ORDER BY r."sentAt" DESC NULLS LAST, r."id" DESC))[1] AS "lastStatus"
      FROM "RecruiterBlastRecipient" r JOIN "RecruiterBlast" b ON b."id" = r."blastId"
      WHERE ${where}
      GROUP BY lower(r."email")
      ORDER BY max(r."sentAt") DESC NULLS LAST, lower(r."email")
      LIMIT ${paging.take} OFFSET ${paging.skip}`),
    prisma.$queryRaw<{ c: number }[]>(Prisma.sql`
      SELECT count(DISTINCT lower(r."email"))::int AS c
      FROM "RecruiterBlastRecipient" r JOIN "RecruiterBlast" b ON b."id" = r."blastId"
      WHERE ${where}`),
  ]);
  const total = totalRows[0]?.c ?? 0;
  return NextResponse.json({ recruiters: rows, ...pageInfo(total, paging) });
});
