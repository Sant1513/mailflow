import { prisma } from '@/lib/db/client';
import { ForbiddenError, type AppSession } from '@/lib/auth/session';
import { Role } from '@prisma/client';

/**
 * Loads a conversation with everything the detail view needs, enforcing
 * workspace ownership in one place (§94). In lib/ because Next.js route
 * files may only export HTTP handlers.
 */
export async function loadConversationForSession(session: AppSession, conversationId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      contact: true,
      account: { select: { id: true, emailAddress: true, displayName: true, status: true } },
      assignee: { select: { id: true, name: true, email: true } },
      messages: { orderBy: { sentAt: 'asc' }, include: { attachments: true } },
      notes: { orderBy: { createdAt: 'asc' }, include: { author: { select: { id: true, name: true } } } },
      tags: { include: { tag: true } },
      followUps: { orderBy: { dueDate: 'asc' } },
    },
  });
  if (!conversation) return null;
  if (conversation.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError('Not your workspace');
  }
  return conversation;
}

export type LoadedConversation = NonNullable<Awaited<ReturnType<typeof loadConversationForSession>>>;
