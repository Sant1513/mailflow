import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';

export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  if (!session.workspaceId) return NextResponse.json({ tags: [] });
  const tags = await prisma.tag.findMany({
    where: { workspaceId: session.workspaceId },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  return NextResponse.json({ tags });
});
