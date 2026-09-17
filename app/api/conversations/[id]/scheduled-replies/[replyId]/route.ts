import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';

/** DELETE — cancel a PENDING scheduled reply. */
export const DELETE = withErrorHandling(async (_req, { params }: { params: { id: string; replyId: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);

  const reply = await prisma.scheduledReply.findUnique({
    where: { id: params.replyId },
    include: { conversation: { select: { workspaceId: true } } },
  });

  if (!reply || reply.conversation.workspaceId !== session.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (reply.conversationId !== params.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (reply.status !== 'PENDING') {
    return NextResponse.json({ error: `Cannot cancel a reply with status ${reply.status}` }, { status: 409 });
  }

  await prisma.scheduledReply.update({
    where: { id: params.replyId },
    data: { status: 'CANCELLED' },
  });

  return NextResponse.json({ ok: true });
});
