import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { loadConversationForSession } from '@/lib/conversations/access';

const createSchema = z.object({
  scheduledFor: z.string().min(1),
  html: z.string().min(1, 'Reply body is required'),
  plainText: z.string().default(''),
  cc: z.array(z.string().email()).max(25).default([]),
  newThread: z.boolean().default(false),
});

/** GET — list PENDING scheduled replies for this conversation. */
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const conversation = await loadConversationForSession(session, params.id);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const replies = await prisma.scheduledReply.findMany({
    where: { conversationId: conversation.id, status: 'PENDING' },
    orderBy: { scheduledFor: 'asc' },
    select: {
      id: true,
      scheduledFor: true,
      html: true,
      plainText: true,
      cc: true,
      newThread: true,
      status: true,
      createdAt: true,
      createdBy: { select: { id: true, name: true } },
    },
  });

  return NextResponse.json({ replies });
});

/** POST — schedule a reply for future delivery. */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const conversation = await loadConversationForSession(session, params.id);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = createSchema.parse(await req.json());
  const scheduledFor = new Date(body.scheduledFor);
  if (isNaN(scheduledFor.getTime())) {
    return NextResponse.json({ error: 'Invalid scheduledFor date' }, { status: 400 });
  }
  if (scheduledFor <= new Date()) {
    return NextResponse.json({ error: 'scheduledFor must be in the future' }, { status: 400 });
  }

  if (!session.workspaceId) {
    return NextResponse.json({ error: 'No workspace on session' }, { status: 403 });
  }

  const reply = await prisma.scheduledReply.create({
    data: {
      conversationId: conversation.id,
      workspaceId: session.workspaceId,
      createdById: session.userId,
      scheduledFor,
      html: body.html,
      plainText: body.plainText,
      cc: body.cc,
      newThread: body.newThread,
    },
    select: {
      id: true,
      scheduledFor: true,
      cc: true,
      newThread: true,
      status: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ reply }, { status: 201 });
});
