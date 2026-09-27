import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadConversationForSession } from '@/lib/conversations/access';
import { AI_DRAFT_STATUS } from '@/lib/ai/triage';

/** GET — the AI draft waiting for approval on this conversation, if any. */
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const conversation = await loadConversationForSession(session, params.id);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const draft = await prisma.scheduledReply.findFirst({
    where: { conversationId: conversation.id, status: AI_DRAFT_STATUS },
    orderBy: { createdAt: 'desc' },
    select: { id: true, html: true, plainText: true, createdAt: true },
  });
  return NextResponse.json({ draft });
});

const patchSchema = z.object({
  draftId: z.string().min(1),
  /** SENT after the reply went out through /reply; CANCELLED when discarded. */
  status: z.enum(['SENT', 'CANCELLED']),
  edited: z.boolean().optional(),
});

export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const conversation = await loadConversationForSession(session, params.id);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const body = patchSchema.parse(await req.json());

  const res = await prisma.scheduledReply.updateMany({
    where: { id: body.draftId, conversationId: conversation.id, status: AI_DRAFT_STATUS },
    data: { status: body.status, ...(body.status === 'SENT' ? { sentAt: new Date() } : {}) },
  });
  if (!res.count) return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  const action = body.status === 'SENT' ? 'AI_DRAFT_SENT' : body.edited ? 'AI_DRAFT_EDITED' : 'AI_DRAFT_DISCARDED';
  await audit(session, action, {
    targetType: 'Conversation',
    targetId: conversation.id,
    metadata: { draftId: body.draftId, edited: body.edited ?? false },
  });
  return NextResponse.json({ ok: true });
});
