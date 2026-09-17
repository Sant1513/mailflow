import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';

const bodySchema = z.object({ targetId: z.string() });

/**
 * POST /api/conversations/[id]/merge
 * Body: { targetId: string }
 *
 * Moves all messages, notes, follow-ups, and tags from the source conversation
 * (id) into the target conversation (targetId), then deletes the source.
 * The currently viewed conversation should be the target (pass its id as
 * targetId); the selected "other" conversation is the source (path id).
 */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);

  const { targetId } = bodySchema.parse(await req.json());
  const sourceId = params.id;

  if (sourceId === targetId) {
    return NextResponse.json({ error: 'Cannot merge a conversation with itself' }, { status: 400 });
  }

  // Load both conversations — only minimal fields needed here.
  const [source, target] = await Promise.all([
    prisma.conversation.findUnique({
      where: { id: sourceId },
      select: { id: true, workspaceId: true, subject: true, unread: true },
    }),
    prisma.conversation.findUnique({
      where: { id: targetId },
      select: { id: true, workspaceId: true, unread: true, firstMessageAt: true, lastMessageAt: true },
    }),
  ]);

  if (!source) return NextResponse.json({ error: 'Source conversation not found' }, { status: 404 });
  if (!target) return NextResponse.json({ error: 'Target conversation not found' }, { status: 404 });

  // Both must belong to this session's workspace.
  if (source.workspaceId !== session.workspaceId || target.workspaceId !== session.workspaceId) {
    return NextResponse.json({ error: 'Both conversations must be in your workspace' }, { status: 403 });
  }

  // 1. Move messages, internal notes, and follow-ups to target.
  await prisma.conversationMessage.updateMany({
    where: { conversationId: sourceId },
    data: { conversationId: targetId },
  });
  await prisma.internalNote.updateMany({
    where: { conversationId: sourceId },
    data: { conversationId: targetId },
  });
  await prisma.followUp.updateMany({
    where: { conversationId: sourceId },
    data: { conversationId: targetId },
  });

  // 2. Move tags — skip any tag already on the target to avoid primary-key conflicts.
  const sourceTags = await prisma.conversationTag.findMany({ where: { conversationId: sourceId } });
  for (const st of sourceTags) {
    await prisma.conversationTag.upsert({
      where: { conversationId_tagId: { conversationId: targetId, tagId: st.tagId } },
      create: { conversationId: targetId, tagId: st.tagId },
      update: {}, // already there — nothing to change
    });
  }

  // 3. Write a merge note on the target so the timeline records what happened.
  await prisma.internalNote.create({
    data: {
      conversationId: targetId,
      authorId: session.userId,
      body: `Merged from conversation: "${source.subject}"`,
    },
  });

  // 4. Re-aggregate target stats now that all messages have been moved.
  const agg = await prisma.conversationMessage.aggregate({
    where: { conversationId: targetId },
    _count: { _all: true },
    _min: { sentAt: true },
    _max: { sentAt: true },
  });

  await prisma.conversation.update({
    where: { id: targetId },
    data: {
      messageCount: agg._count._all,
      firstMessageAt: agg._min.sentAt ?? target.firstMessageAt,
      lastMessageAt: agg._max.sentAt ?? target.lastMessageAt,
      // Mark unread if the source was unread.
      unread: target.unread || source.unread,
    },
  });

  // 5. Delete source — cascade removes any remaining ConversationTag and
  //    ScheduledReply rows tied to it.
  await prisma.conversation.delete({ where: { id: sourceId } });

  // 6. Audit trail.
  await audit(session, 'CONVERSATION_MERGE', {
    targetType: 'Conversation',
    targetId,
    metadata: { sourceId, sourceSubject: source.subject },
  });

  return NextResponse.json({ ok: true, targetId });
});
