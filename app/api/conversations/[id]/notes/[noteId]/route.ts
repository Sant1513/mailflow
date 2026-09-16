import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';

export const DELETE = withErrorHandling(async (_req, { params }: { params: { id: string; noteId: string } }) => {
  const session = await requireSession();

  const note = await prisma.internalNote.findUnique({
    where: { id: params.noteId },
    include: { conversation: { select: { workspaceId: true } } },
  });
  if (!note || note.conversation.workspaceId !== session.workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (note.authorId !== session.userId && session.role !== 'ADMIN' && session.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Only the author or an admin can delete a note.' }, { status: 403 });
  }

  await prisma.internalNote.delete({ where: { id: params.noteId } });
  await audit(session, 'CONVERSATION_NOTE_DELETE', { targetType: 'InternalNote', targetId: params.noteId });

  return NextResponse.json({ ok: true });
});
