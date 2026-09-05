import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadConversationForSession } from '@/lib/conversations/access';

const noteSchema = z.object({ body: z.string().min(1).max(10_000) });

/**
 * §58 internal notes. Stored in their own table, never in
 * ConversationMessage, so there is no code path by which a note could be
 * sent to the student.
 */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const conversation = await loadConversationForSession(session, params.id);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { body } = noteSchema.parse(await req.json());

  const note = await prisma.internalNote.create({
    data: { conversationId: conversation.id, authorId: session.userId, body },
    include: { author: { select: { id: true, name: true } } },
  });

  await prisma.recipientHistory.create({
    data: {
      contactId: conversation.contactId,
      type: 'NOTE',
      summary: `${session.name} added a note: "${body.slice(0, 100)}${body.length > 100 ? '…' : ''}"`,
      refId: note.id,
    },
  });

  await audit(session, 'CONVERSATION_NOTE', { targetType: 'Conversation', targetId: conversation.id });

  return NextResponse.json({ note }, { status: 201 });
});
