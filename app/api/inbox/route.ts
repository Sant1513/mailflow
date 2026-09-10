import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId } from '@/lib/permissions/workspace';
import { ConversationStatus, Prisma } from '@prisma/client';

/**
 * §51 Inbox list. Filters: unread | mine | open | waiting | resolved | all,
 * plus tag, campaign and free-text search (§64).
 */
export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));

  const filter = url.searchParams.get('filter') ?? 'open';
  const tag = url.searchParams.get('tag');
  const q = url.searchParams.get('q')?.trim();
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(100, Number(url.searchParams.get('pageSize') ?? '40'));

  const where: Prisma.ConversationWhereInput = { workspaceId };

  switch (filter) {
    case 'unread':
      where.unread = true;
      break;
    case 'mine':
      where.assigneeId = session.userId;
      break;
    case 'open':
      where.status = { in: [ConversationStatus.OPEN, ConversationStatus.IN_PROGRESS] };
      break;
    case 'waiting':
      where.status = ConversationStatus.WAITING_FOR_STUDENT;
      break;
    case 'resolved':
      where.status = { in: [ConversationStatus.RESOLVED, ConversationStatus.CLOSED] };
      break;
    case 'all':
    default:
      break;
  }

  if (tag) where.tags = { some: { tag: { name: tag } } };

  if (q) {
    where.OR = [
      { subject: { contains: q, mode: 'insensitive' } },
      { recipientEmail: { contains: q, mode: 'insensitive' } },
      { contact: { name: { contains: q, mode: 'insensitive' } } },
      { messages: { some: { plainTextBody: { contains: q, mode: 'insensitive' } } } },
      { gmailThreadId: q },
    ];
  }

  const [conversations, total, counts] = await Promise.all([
    prisma.conversation.findMany({
      where,
      orderBy: [{ unread: 'desc' }, { lastMessageAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        contact: { select: { id: true, name: true, primaryEmail: true } },
        assignee: { select: { id: true, name: true } },
        tags: { include: { tag: { select: { name: true, color: true } } } },
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
          select: { snippet: true, direction: true, sentAt: true, classification: true, senderName: true },
        },
      },
    }),
    prisma.conversation.count({ where }),
    // Badge counts for the filter rail, independent of the active filter.
    Promise.all([
      prisma.conversation.count({ where: { workspaceId, unread: true } }),
      prisma.conversation.count({ where: { workspaceId, assigneeId: session.userId, status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
      prisma.conversation.count({ where: { workspaceId, status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
      prisma.conversation.count({ where: { workspaceId, status: 'WAITING_FOR_STUDENT' } }),
    ]),
  ]);

  return NextResponse.json({
    conversations: conversations.map((c) => ({
      id: c.id,
      subject: c.subject,
      status: c.status,
      unread: c.unread,
      lastMessageAt: c.lastMessageAt,
      messageCount: c.messageCount,
      contact: c.contact,
      recipientEmail: c.recipientEmail,
      assignee: c.assignee,
      tags: c.tags.map((t) => t.tag),
      lastMessage: c.messages[0] ?? null,
    })),
    total,
    page,
    pageSize,
    counts: { unread: counts[0], mine: counts[1], open: counts[2], waiting: counts[3] },
  });
});
