import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { buildContactWhere } from '../_filterContacts';

/**
 * POST /api/segments/preview
 * Body: { filters }
 * Returns matching contacts without creating a segment.
 */
export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  const body = await req.json();
  const filters = (body.filters ?? {}) as Record<string, unknown>;

  const contacts = await prisma.contact.findMany({
    where: { workspaceId: session.workspaceId!, ...buildContactWhere(filters) },
    select: { id: true, name: true, primaryEmail: true },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });

  return NextResponse.json({ contacts, total: contacts.length });
});
