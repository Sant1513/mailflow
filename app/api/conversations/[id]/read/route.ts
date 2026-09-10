import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { loadConversationForSession } from '@/lib/conversations/access';

const schema = z.object({ read: z.boolean().default(true) });

/**
 * §52 read state. Opening a conversation clears its unread flag and the
 * unreadReply flag on every linked record, so the grid and the inbox badge
 * agree. Not audited — reading is not a state change worth a trail.
 */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const conversation = await loadConversationForSession(session, params.id);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { read } = schema.parse(await req.json().catch(() => ({})));

  await prisma.$transaction([
    prisma.conversation.update({ where: { id: conversation.id }, data: { unread: !read } }),
    prisma.conversationMessage.updateMany({
      where: { conversationId: conversation.id, direction: 'INBOUND' },
      data: { isRead: read },
    }),
    prisma.record.updateMany({
      where: { contactId: conversation.contactId },
      data: { unreadReply: !read },
    }),
  ]);

  return NextResponse.json({ ok: true, unread: !read });
});
