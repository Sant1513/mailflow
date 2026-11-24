import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId } from '@/lib/permissions/workspace';
import { EmailJobStatus, MessageDirection, Prisma } from '@prisma/client';
import { blastScope } from '@/lib/orgs/scope';

/**
 * §61/§126 workspace email history. Two views over immutable rows:
 *   direction=sent      every EmailJob (campaign/automation sends) with its outcome
 *   direction=received  every inbound ConversationMessage with its classification
 *   direction=recruiter  every recruiter in a Recruiter Bulk Send (own tables: no Contact or Record is made for them)
 * Filters: `q` (address / subject / campaign), `status`, `campaignId`, paging.
 */
export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));
  const dir = url.searchParams.get('direction');
  const direction = dir === 'received' ? 'received' : dir === 'recruiter' ? 'recruiter' : 'sent';
  const q = url.searchParams.get('q')?.trim();
  const status = url.searchParams.get('status')?.trim();
  const campaignId = url.searchParams.get('campaignId')?.trim();
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? '50')));

  // Recruiter Bulk Send keeps its recipients in its own tables, so a recruiter emailed that way has no contact, record or
  // campaign email: this view is where "what did we send to this address?" is answered for those sends.
  // Admins see their organisation's Recruiter Bulk Send emails, a Super Admin every organisation's (narrowed by ?org= / ?sender=).
  const narrow = { orgUnitId: url.searchParams.get('org')?.trim() || null, createdById: url.searchParams.get('sender')?.trim() || null };
  const scopeWhere = blastScope(session, narrow);
  const recruiterWhere = (search?: string): Prisma.RecruiterBlastRecipientWhereInput => ({
    blast: scopeWhere ?? { id: '__none__' },
    ...(search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
            { blast: { name: { contains: search, mode: 'insensitive' } } },
            { blast: { subject: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  });
  if (direction === 'recruiter') {
    const where: Prisma.RecruiterBlastRecipientWhereInput = { ...recruiterWhere(q), ...(status ? { status } : {}) };
    const [rows, total, byStatus] = await Promise.all([
      prisma.recruiterBlastRecipient.findMany({
        where,
        orderBy: [{ sentAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, email: true, name: true, status: true, skipReason: true, sentAt: true, openedAt: true, openCount: true, repliedAt: true,
          blast: { select: { id: true, name: true, subject: true, round: true, parentBlastId: true, orgUnitId: true, createdById: true } },
          group: { select: { fromEmail: true } },
        },
      }),
      prisma.recruiterBlastRecipient.count({ where }),
      prisma.recruiterBlastRecipient.groupBy({ by: ['status'], where: recruiterWhere(q), _count: { _all: true } }),
    ]);
    // Who and which organisations the filters can offer (a Super Admin: everyone; an Admin: their organisation's senders).
    const senderIds = scopeWhere
      ? (await prisma.recruiterBlast.findMany({ where: blastScope(session) ?? { id: '__none__' }, distinct: ['createdById'], select: { createdById: true } })).map((s) => s.createdById)
      : [];
    const people = await prisma.user.findMany({ where: { id: { in: [...new Set([...senderIds, ...rows.map((r) => r.blast.createdById)])] } }, select: { id: true, name: true } });
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    const orgNames = new Map((await prisma.orgUnit.findMany({ where: { organizationId: session.organizationId }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
    const senders = senderIds.map((id) => ({ id, name: nameOf.get(id) ?? 'Unknown' }));
    const orgs = session.role === 'SUPER_ADMIN' ? await prisma.orgUnit.findMany({ where: { organizationId: session.organizationId }, orderBy: { name: 'asc' }, select: { id: true, name: true } }) : [];
    return NextResponse.json({
      direction,
      canSee: !!scopeWhere,
      items: rows.map((r) => ({ ...r, blast: { ...r.blast, sentBy: nameOf.get(r.blast.createdById) ?? null, orgName: r.blast.orgUnitId ? orgNames.get(r.blast.orgUnitId) ?? null : null } })),
      filters: { senders, orgs },
      total,
      counts: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    });
  }

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
    // A search that finds nothing here may still be an address emailed through Recruiter Bulk Send: say so.
    const recruiterMatches = q && q.length >= 3 && !campaignId && !status && scopeWhere ? await prisma.recruiterBlastRecipient.count({ where: recruiterWhere(q) }) : 0;
    return NextResponse.json({
      direction,
      items: jobs,
      recruiterMatches,
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
