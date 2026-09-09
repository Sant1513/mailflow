import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadConversationForSession } from '@/lib/conversations/access';
import { splitMessageBody } from '@/lib/conversations/messageView';
import { notifyAssignment, notifyResolution } from '@/lib/conversations/notify';
import { ConversationStatus } from '@prisma/client';

export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const conversation = await loadConversationForSession(session, params.id);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (conversation.workspaceId !== session.workspaceId) {
    await audit(session, 'ADMIN_VIEW', { targetType: 'Conversation', targetId: conversation.id });
  }

  // Assignee picker needs the workspace's members.
  const members = await prisma.user.findMany({
    where: { organizationId: session.organizationId, status: 'ACTIVE' },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
  });

  // §50: bodies are split server-side (sanitised HTML, quoted history apart)
  // so the browser never runs the sanitiser and never sees raw inbound HTML.
  const messages = (conversation as any).messages?.map((m: any) => {
    const split = splitMessageBody({ htmlBody: m.htmlBody, plainTextBody: m.plainTextBody, snippet: m.snippet });
    return { ...m, htmlBody: undefined, bodyMain: split.main, bodyQuoted: split.quoted };
  });

  return NextResponse.json({ conversation: { ...conversation, messages }, members, viewerId: session.userId });
});

const patchSchema = z.object({
  status: z.nativeEnum(ConversationStatus).optional(),
  /** null = unassign */
  assigneeId: z.string().nullable().optional(),
});

/** §56 status and §57 assignment — both audited. */
export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const conversation = await loadConversationForSession(session, params.id);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = patchSchema.parse(await req.json());
  const notify: Record<string, unknown> = {};

  if (body.assigneeId) {
    const assignee = await prisma.user.findFirst({
      where: { id: body.assigneeId, organizationId: session.organizationId, status: 'ACTIVE' },
    });
    if (!assignee) return NextResponse.json({ error: 'Assignee not found in this organization' }, { status: 400 });
  }

  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.assigneeId !== undefined ? { assigneeId: body.assigneeId } : {}),
    },
  });

  if (body.status !== undefined && body.status !== conversation.status) {
    await audit(session, 'CONVERSATION_STATUS_CHANGE', {
      targetType: 'Conversation',
      targetId: conversation.id,
      metadata: { from: conversation.status, to: body.status },
    });
    await prisma.recipientHistory.create({
      data: {
        contactId: conversation.contactId,
        type: 'STATUS_CHANGE',
        summary: `Conversation marked ${body.status.replace(/_/g, ' ').toLowerCase()} by ${session.name}`,
        refId: conversation.id,
      },
    });
    // §57/§87: closure goes to the assignee in the same email + Slack threads.
    if (body.status === ConversationStatus.RESOLVED || body.status === ConversationStatus.CLOSED) {
      notify.resolution = await notifyResolution(conversation.id, body.status, session);
    }
  }

  if (body.assigneeId !== undefined && body.assigneeId !== conversation.assigneeId) {
    await audit(session, 'CONVERSATION_ASSIGN', {
      targetType: 'Conversation',
      targetId: conversation.id,
      metadata: { from: conversation.assigneeId, to: body.assigneeId },
    });
    if (body.assigneeId && body.assigneeId !== session.userId) {
      // §57/§87: in-app + email + Slack, all recorded; never blocks the assignment.
      notify.assignment = await notifyAssignment(conversation.id, body.assigneeId, session);
    }
  }

  return NextResponse.json({ conversation: updated, notify });
});
