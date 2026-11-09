import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId } from '@/lib/permissions/workspace';
import { pageInfo, parsePaging } from '@/lib/api/paging';

/** Contacts of the workspace, newest activity first: ?q= search, ?page=&pageSize= paging, with the total. */
export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));
  const q = url.searchParams.get('q')?.trim();
  const paging = parsePaging(url.searchParams, { pageSize: 50 });

  const where = {
    workspaceId,
    ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { primaryEmail: { contains: q, mode: 'insensitive' as const } }] } : {}),
  };
  const [contacts, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      skip: paging.skip,
      take: paging.take,
      include: { _count: { select: { records: true, conversations: true } } },
    }),
    prisma.contact.count({ where }),
  ]);

  return NextResponse.json({ contacts, ...pageInfo(total, paging) });
});
