import { NextResponse } from 'next/server';
import { pageInfo, parsePaging } from '@/lib/api/paging';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { requireBlastAdmin, sendableMailboxes, requireBlastReader } from '@/lib/recruiterSend/access';
import { waitUntil } from '@vercel/functions';
import { nudgeStuckSends } from '@/lib/recruiterSend/worker';
import { DEFAULT_GAP } from '@/lib/recruiterSend/core';

/** Mail → Recruiter Bulk Send: the list of sends (GET) and a new draft (POST). Admins only. */
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req) => {
  const session = await requireBlastReader();
  // Watchdog: a send that should be moving but isn't gets a fresh run (in the background).
  try { waitUntil(nudgeStuckSends('page').catch(() => 0)); } catch { void nudgeStuckSends('page').catch(() => 0); }
  const paging = parsePaging(new URL(req.url).searchParams, { pageSize: 25 });
  const where = { organizationId: session.organizationId, ...(session.role === 'SUPER_ADMIN' ? {} : { workspaceId: session.workspaceId! }) };
  const total = await prisma.recruiterBlast.count({ where });
  const blasts = await prisma.recruiterBlast.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    skip: paging.skip,
    take: paging.take,
    select: { id: true, name: true, mode: true, status: true, subject: true, createdAt: true, startedAt: true, completedAt: true, scheduledAt: true, note: true },
  });
  const ids = blasts.map((b) => b.id);
  const [recipientCounts, groupStats] = ids.length
    ? await Promise.all([
        prisma.recruiterBlastRecipient.groupBy({ by: ['blastId', 'status'], where: { blastId: { in: ids } }, _count: { _all: true } }),
        prisma.recruiterBlastGroup.groupBy({ by: ['blastId'], where: { blastId: { in: ids }, status: 'SENT' }, _sum: { openCount: true }, _count: { _all: true } }),
      ])
    : [[], []];
  const openedRecipients = ids.length
    ? await prisma.recruiterBlastRecipient.groupBy({ by: ['blastId'], where: { blastId: { in: ids }, openCount: { gt: 0 } }, _count: { _all: true } })
    : [];
  return NextResponse.json({
    ...pageInfo(total, paging),
    blasts: blasts.map((b) => {
      const counts = Object.fromEntries(recipientCounts.filter((c) => c.blastId === b.id).map((c) => [c.status, c._count._all]));
      const g = groupStats.find((x) => x.blastId === b.id);
      return {
        ...b,
        recipients: Object.values(counts).reduce((n: number, v) => n + (v as number), 0),
        sent: counts.SENT ?? 0,
        skipped: (counts.SKIPPED ?? 0) + (counts.FAILED ?? 0),
        messagesSent: g?._count._all ?? 0,
        opens: g?._sum.openCount ?? 0,
        openedRecruiters: b.mode === 'INDIVIDUAL' ? openedRecipients.find((o) => o.blastId === b.id)?._count._all ?? 0 : null,
      };
    }),
  });
});

export const POST = withErrorHandling(async () => {
  const session = await requireBlastAdmin();
  const mailboxes = await sendableMailboxes(session);
  const own = mailboxes.find((m) => m.own);
  const blast = await prisma.recruiterBlast.create({
    data: {
      organizationId: session.organizationId,
      workspaceId: session.workspaceId!,
      createdById: session.userId,
      name: `Recruiter send · ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}`,
      mode: 'BCC',
      subject: '',
      html: '',
      plainText: '',
      body: '',
      accountIds: own ? [own.id] : [],
      gapSeconds: DEFAULT_GAP.BCC,
    },
  });
  await audit(session, 'RECRUITER_SEND_CREATE', { targetType: 'RecruiterBlast', targetId: blast.id });
  return NextResponse.json({ id: blast.id });
});
