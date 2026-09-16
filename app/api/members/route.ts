import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';

/** Workspace member list for assignee pickers. */
export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  const members = await prisma.user.findMany({
    where: { organizationId: session.organizationId, status: 'ACTIVE' },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
  });
  return NextResponse.json({ members });
});
