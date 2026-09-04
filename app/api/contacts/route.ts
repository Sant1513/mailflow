import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId } from '@/lib/permissions/workspace';

export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));
  const q = url.searchParams.get('q')?.trim();

  const contacts = await prisma.contact.findMany({
    where: {
      workspaceId,
      ...(q
        ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { primaryEmail: { contains: q, mode: 'insensitive' } }] }
        : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    include: { _count: { select: { records: true, conversations: true } } },
  });

  return NextResponse.json({ contacts });
});
