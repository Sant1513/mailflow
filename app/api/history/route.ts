import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId } from '@/lib/permissions/workspace';
import { EmailJobStatus, MessageDirection, Prisma } from '@prisma/client';

/**
 * §61/§126 workspace email history. Two views over immutable rows:
 *   direction=sent      every EmailJob (campaign/automation sends) with its outcome
 *   direction=received  every inbound ConversationMessage with its classification
 * Filters: `q` (address / subject / campaign), `status`, `campaignId`, paging.
 */
export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));
  const direction = url.searchParams.get('direction') === 'received' ? 'received' : 'sent';
  const q = url.searchParams.get('q')?.trim();
  const status = url.searchParams.get('status')?.trim();
  const campaignId = url.searchParams.get('campaignId')?.trim();
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? '50')));

  if (direction === 'sent') {
    const where: Prisma.EmailJobWhereInput = {
      campaign: { workspaceId },
      ...(campaignId ? { campaignId } : {}),
      ...(status && (Object.values(EmailJobStatus) as string[]).includes(status) ? { status: status as EmailJobStatus } : {}),
      ...(q
        ? {
            OR: [
              { toEmail: { contains: q, mode: 'insensitive' } },
              { subject: { contains: q, mode: 'insensitive' } },
              { campaign: { name: { contains: q, mode: 'insensitive' } } },
              { errorMessage: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [jobs, total, byStatus] = await Promise.all([
      prisma.emailJob.findMany({
        where,
        orderBy: [{ sentAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          toEmail: true,
          subject: true,
          status: true,
          sendReason: true,
          skipReason: true,
          errorCode: true,
          errorMessage: true,
          retryCount: true,
          sentAt: true,
          createdAt: true,
          gmailThreadId: true,
          campaign: { select: { id: true, name: true } },
          batch: { select: { id: true, label: true } },
          record: { select: { id: true, contactId: true, conversationId: true } },
          templateVersion: { select: { version: true } },
        },
      }),
      prisma.emailJob.count({ where }),
      prisma.emailJob.groupBy({ by: ['status'], where: { campaign: { workspaceId } }, _count: { _all: true } }),
    ]);
    return NextResponse.json({
      direction,
      items: jobs,
      total,
      counts: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    });
  }

  const where: Prisma.ConversationMessageWhereInput = {
    direction: MessageDirection.INBOUND,
    conversation: { workspaceId },
    ...(status ? { classification: status as any } : {}),
    ...(q
      ? {
          OR: [
            { senderEmail: { contains: q, mode: 'insensitive' } },
            { senderName: { contains: q, mode: 'insensitive' } },
            { subject: { contains: q, mode: 'insensitive' } },
            { snippet: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const [messages, total, byClass] = await Promise.all([
    prisma.conversationMessage.findMany({
      where,
      orderBy: [{ receivedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        senderEmail: true,
        senderName: true,
        subject: true,
        snippet: true,
        classification: true,
        classificationConfidence: true,
        aiIntent: true,
        receivedAt: true,
        createdAt: true,
        isRead: true,
        conversation: { select: { id: true, subject: true, status: true, contact: { select: { id: true, name: true } } } },
      },
    }),
    prisma.conversationMessage.count({ where }),
    prisma.conversationMessage.groupBy({
      by: ['classification'],
      where: { direction: MessageDirection.INBOUND, conversation: { workspaceId } },
      _count: { _all: true },
    }),
  ]);
  return NextResponse.json({
    direction,
    items: messages,
    total,
    counts: Object.fromEntries(byClass.map((s) => [s.classification, s._count._all])),
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  });
});
