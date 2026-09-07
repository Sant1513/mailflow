import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { ConversationStatus, Prisma, Role } from '@prisma/client';

/**
 * §9 "All Conversations" — every conversation in the organisation for a
 * SUPER_ADMIN, with workspace / status / search filters. Reads are audited
 * like every other cross-workspace admin view.
 */
export const GET = withErrorHandling(async (req) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim();
  const workspaceId = url.searchParams.get('workspaceId')?.trim();
  const status = url.searchParams.get('status')?.trim();
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? '40')));

  const where: Prisma.ConversationWhereInput = {
    organizationId: session.organizationId,
    ...(workspaceId ? { workspaceId } : {}),
    ...(status === 'open'
      ? { status: { in: [ConversationStatus.OPEN, ConversationStatus.IN_PROGRESS, ConversationStatus.WAITING_FOR_STUDENT] } }
      : status === 'resolved'
        ? { status: { in: [ConversationStatus.RESOLVED, ConversationStatus.CLOSED] } }
        : status === 'unread'
          ? { unread: true }
          : {}),
    ...(q
      ? {
          OR: [
            { subject: { contains: q, mode: 'insensitive' } },
            { recipientEmail: { contains: q, mode: 'insensitive' } },
            { contact: { name: { contains: q, mode: 'insensitive' } } },
            { account: { emailAddress: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [conversations, total, workspaces] = await Promise.all([
    prisma.conversation.findMany({
      where,
      orderBy: [{ unread: 'desc' }, { lastMessageAt: { sort: 'desc', nulls: 'last' } }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        subject: true,
        status: true,
        unread: true,
        recipientEmail: true,
        messageCount: true,
        lastMessageAt: true,
        workspace: { select: { id: true, name: true, owner: { select: { name: true } } } },
        contact: { select: { id: true, name: true } },
        account: { select: { emailAddress: true } },
        assignee: { select: { name: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { snippet: true, direction: true, classification: true } },
      },
    }),
    prisma.conversation.count({ where }),
    prisma.workspace.findMany({ where: { organizationId: session.organizationId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);

  await audit(session, 'ADMIN_VIEW', { targetType: 'ConversationList', metadata: { q, workspaceId, status, page } });

  return NextResponse.json({
    conversations: conversations.map((c) => ({ ...c, last: c.messages[0] ?? null, messages: undefined })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    workspaces,
  });
});
