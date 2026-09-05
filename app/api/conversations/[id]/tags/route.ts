import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadConversationForSession } from '@/lib/conversations/access';

const tagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

/** §59 tags. Tags are per-workspace and created on first use. */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const conversation = await loadConversationForSession(session, params.id);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = tagSchema.parse(await req.json());

  const tag = await prisma.tag.upsert({
    where: { workspaceId_name: { workspaceId: conversation.workspaceId, name: body.name } },
    update: body.color ? { color: body.color } : {},
    create: { workspaceId: conversation.workspaceId, name: body.name, color: body.color },
  });

  // Composite PK makes re-tagging idempotent.
  await prisma.conversationTag.upsert({
    where: { conversationId_tagId: { conversationId: conversation.id, tagId: tag.id } },
    update: {},
    create: { conversationId: conversation.id, tagId: tag.id },
  });

  await audit(session, 'CONVERSATION_TAG_ADD', {
    targetType: 'Conversation',
    targetId: conversation.id,
    metadata: { tag: tag.name },
  });

  return NextResponse.json({ tag }, { status: 201 });
});

const untagSchema = z.object({ name: z.string().trim().min(1) });

export const DELETE = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const conversation = await loadConversationForSession(session, params.id);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { name } = untagSchema.parse(await req.json());
  const tag = await prisma.tag.findUnique({
    where: { workspaceId_name: { workspaceId: conversation.workspaceId, name } },
  });
  if (!tag) return NextResponse.json({ ok: true });

  await prisma.conversationTag.deleteMany({ where: { conversationId: conversation.id, tagId: tag.id } });

  await audit(session, 'CONVERSATION_TAG_REMOVE', {
    targetType: 'Conversation',
    targetId: conversation.id,
    metadata: { tag: name },
  });

  return NextResponse.json({ ok: true });
});
