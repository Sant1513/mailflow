import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { buildContactWhere } from '../../_filterContacts';

export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const segment = await prisma.contactSegment.findUnique({ where: { id: params.id } });
  if (!segment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (segment.workspaceId !== session.workspaceId) throw new ForbiddenError();

  const filters = segment.filters as Record<string, unknown>;
  const contacts = await prisma.contact.findMany({
    where: { workspaceId: segment.workspaceId, ...buildContactWhere(filters) },
    select: { id: true, name: true, primaryEmail: true },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });

  return NextResponse.json({ contacts, total: contacts.length });
});
