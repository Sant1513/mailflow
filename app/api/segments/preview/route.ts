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

  const where = { workspaceId: session.workspaceId!, ...buildContactWhere(filters) };
  // A sample to show, and the real number that match (not capped at the sample size).
  const [contacts, total] = await Promise.all([
    prisma.contact.findMany({ where, select: { id: true, name: true, primaryEmail: true }, orderBy: { updatedAt: 'desc' }, take: 200 }),
    prisma.contact.count({ where }),
  ]);

  return NextResponse.json({ contacts, total });
});
