import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { buildContactWhere } from '../../_filterContacts';
import { pageInfo, parsePaging } from '@/lib/api/paging';

/** A segment's members, paged (?page=&pageSize=), with the real total. */
export const GET = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const segment = await prisma.contactSegment.findUnique({ where: { id: params.id } });
  if (!segment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (segment.workspaceId !== session.workspaceId) throw new ForbiddenError();

  const filters = segment.filters as Record<string, unknown>;
  const paging = parsePaging(new URL(req.url).searchParams, { pageSize: 50 });
  const where = { workspaceId: segment.workspaceId, ...buildContactWhere(filters) };
  const [contacts, total] = await Promise.all([
    prisma.contact.findMany({ where, select: { id: true, name: true, primaryEmail: true }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], skip: paging.skip, take: paging.take }),
    prisma.contact.count({ where }),
  ]);

  return NextResponse.json({ contacts, ...pageInfo(total, paging) });
});
