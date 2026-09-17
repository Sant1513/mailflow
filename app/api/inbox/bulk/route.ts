import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { ConversationStatus } from '@prisma/client';
import { audit } from '@/lib/audit/log';

const bulkSchema = z.object({
  ids: z.array(z.string().cuid()).min(1).max(100),
  action: z.enum(['resolve', 'reopen', 'mark_read', 'mark_unread', 'assign', 'tag', 'untag']),
  assigneeId: z.string().cuid().optional().nullable(),
  tagName: z.string().min(1).max(100).optional(),
});

export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  if (!session.workspaceId) return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  const workspaceId = session.workspaceId;
  const body = bulkSchema.parse(await req.json());

  // Restrict to conversations in this workspace only.
  const allowed = await prisma.conversation.findMany({
    where: { id: { in: body.ids }, workspaceId },
    select: { id: true },
  });
  const validIds = allowed.map((c) => c.id);
  if (!validIds.length) return NextResponse.json({ error: 'No valid conversations.' }, { status: 404 });

  let updated = 0;

  switch (body.action) {
    case 'resolve':
      await prisma.conversation.updateMany({
        where: { id: { in: validIds } },
        data: { status: ConversationStatus.RESOLVED, unread: false },
      });
      updated = validIds.length;
      break;

    case 'reopen':
      await prisma.conversation.updateMany({
        where: { id: { in: validIds } },
        data: { status: ConversationStatus.OPEN },
      });
      updated = validIds.length;
      break;

    case 'mark_read':
      await prisma.conversation.updateMany({
        where: { id: { in: validIds } },
        data: { unread: false },
      });
      updated = validIds.length;
      break;

    case 'mark_unread':
      await prisma.conversation.updateMany({
        where: { id: { in: validIds } },
        data: { unread: true },
      });
      updated = validIds.length;
      break;

    case 'assign':
      await prisma.conversation.updateMany({
        where: { id: { in: validIds } },
        data: { assigneeId: body.assigneeId ?? null },
      });
      updated = validIds.length;
      break;

    case 'tag': {
      if (!body.tagName) return NextResponse.json({ error: 'tagName required.' }, { status: 400 });
      const tag = await prisma.tag.upsert({
        where: { workspaceId_name: { workspaceId, name: body.tagName } },
        create: { workspaceId, name: body.tagName },
        update: {},
      });
      for (const id of validIds) {
        await prisma.conversationTag.upsert({
          where: { conversationId_tagId: { conversationId: id, tagId: tag.id } },
          create: { conversationId: id, tagId: tag.id },
          update: {},
        });
      }
      updated = validIds.length;
      break;
    }

    case 'untag': {
      if (!body.tagName) return NextResponse.json({ error: 'tagName required.' }, { status: 400 });
      const tag = await prisma.tag.findUnique({
        where: { workspaceId_name: { workspaceId, name: body.tagName } },
      });
      if (tag) {
        await prisma.conversationTag.deleteMany({
          where: { tagId: tag.id, conversationId: { in: validIds } },
        });
      }
      updated = validIds.length;
      break;
    }
  }

  await audit(session, 'INBOX_BULK_ACTION', {
    targetType: 'Conversation',
    metadata: { action: body.action, count: updated, ids: validIds },
  });

  return NextResponse.json({ ok: true, updated });
});
