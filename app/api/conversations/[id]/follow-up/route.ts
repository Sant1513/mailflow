import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadConversationForSession } from '@/lib/conversations/access';

const createSchema = z.object({
  dueDate: z.string().datetime(),
  note: z.string().max(2000).optional(),
});

/** §60 follow-ups. Also flags the linked records so the grid shows it. */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const conversation = await loadConversationForSession(session, params.id);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = createSchema.parse(await req.json());
  const dueDate = new Date(body.dueDate);

  const followUp = await prisma.followUp.create({
    data: { conversationId: conversation.id, dueDate, note: body.note ?? null },
  });

  await prisma.record.updateMany({
    where: { contactId: conversation.contactId },
    data: { followUpRequired: true },
  });

  await prisma.recipientHistory.create({
    data: {
      contactId: conversation.contactId,
      type: 'FOLLOW_UP',
      summary: `Follow-up set for ${dueDate.toISOString().slice(0, 10)}${body.note ? `: ${body.note.slice(0, 80)}` : ''}`,
      refId: followUp.id,
    },
  });

  await audit(session, 'CONVERSATION_FOLLOW_UP_CREATE', {
    targetType: 'Conversation',
    targetId: conversation.id,
    metadata: { dueDate: body.dueDate },
  });

  return NextResponse.json({ followUp }, { status: 201 });
});

const completeSchema = z.object({ followUpId: z.string(), completed: z.boolean().default(true) });

export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const conversation = await loadConversationForSession(session, params.id);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = completeSchema.parse(await req.json());
  const existing = conversation.followUps.find((f) => f.id === body.followUpId);
  if (!existing) return NextResponse.json({ error: 'Follow-up not found on this conversation' }, { status: 404 });

  const followUp = await prisma.followUp.update({
    where: { id: existing.id },
    data: { completed: body.completed },
  });

  // Clear the record flag only when nothing is still pending for this contact.
  const stillOpen = await prisma.followUp.count({
    where: { conversation: { contactId: conversation.contactId }, completed: false },
  });
  if (stillOpen === 0) {
    await prisma.record.updateMany({
      where: { contactId: conversation.contactId },
      data: { followUpRequired: false },
    });
  }

  await audit(session, 'CONVERSATION_FOLLOW_UP_UPDATE', {
    targetType: 'Conversation',
    targetId: conversation.id,
    metadata: { followUpId: existing.id, completed: body.completed },
  });

  return NextResponse.json({ followUp });
});
