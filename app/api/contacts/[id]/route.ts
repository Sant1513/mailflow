import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { Role } from '@prisma/client';

// §61 recipient timeline: everything about a contact in one chronological
// view — records across datasets, conversations, notes, follow-ups.
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const contact = await prisma.contact.findUnique({
    where: { id: params.id },
    include: {
      records: { include: { dataset: { select: { id: true, name: true } } } },
      conversations: {
        include: { messages: { orderBy: { createdAt: 'asc' } }, notes: true, followUps: true, tags: { include: { tag: true } } },
        orderBy: { lastMessageAt: 'desc' },
      },
      recipientHistory: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (contact.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError();
  }

  return NextResponse.json({ contact });
});
