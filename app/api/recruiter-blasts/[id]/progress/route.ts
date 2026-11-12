import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { loadBlastStatus, requireBlastReader } from '@/lib/recruiterSend/access';
import { waitUntil } from '@vercel/functions';
import { nudgeStuckSends } from '@/lib/recruiterSend/worker';

export const dynamic = 'force-dynamic';

/**
 * Live progress of one recruiter send, for the open page's poll: status, counts, totals and the
 * groups' state (slim columns), with emails sent per mailbox. No email HTML, preview, recruiter
 * rows or 24-hour mailbox usage: the full GET /api/recruiter-blasts/[id] is loaded again only when
 * the status changes, so a long send costs a small response every 15 s (free-tier data transfer).
 */
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireBlastReader();
  const blast = await loadBlastStatus(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // Same watchdog as the full GET: a send that should be moving but isn't gets a fresh run.
  try { waitUntil(nudgeStuckSends('page').catch(() => 0)); } catch { void nudgeStuckSends('page').catch(() => 0); }

  const [statusCounts, replied, groupTotals, openedRecruiters, groups] = await Promise.all([
    prisma.recruiterBlastRecipient.groupBy({ by: ['status'], where: { blastId: blast.id }, _count: { _all: true } }),
    prisma.recruiterBlastRecipient.count({ where: { blastId: blast.id, repliedAt: { not: null } } }),
    prisma.recruiterBlastGroup.groupBy({ by: ['status'], where: { blastId: blast.id }, _count: { _all: true }, _sum: { openCount: true } }),
    prisma.recruiterBlastRecipient.count({ where: { blastId: blast.id, openCount: { gt: 0 } } }),
    prisma.recruiterBlastGroup.findMany({
      where: { blastId: blast.id },
      orderBy: { seq: 'asc' },
      take: 500,
      select: { id: true, seq: true, status: true, recipientCount: true, fromEmail: true, sentAt: true, openCount: true, firstOpenedAt: true, lastOpenedAt: true, error: true },
    }),
  ]);
  const counts = Object.fromEntries(statusCounts.map((c) => [c.status, c._count._all]));
  const sentByMailbox: Record<string, number> = {};
  for (const g of groups) if (g.status === 'SENT' && g.fromEmail) sentByMailbox[g.fromEmail] = (sentByMailbox[g.fromEmail] ?? 0) + 1;

  return NextResponse.json({
    blast: { id: blast.id, status: blast.status, scheduledAt: blast.scheduledAt, startedAt: blast.startedAt, completedAt: blast.completedAt, updatedAt: blast.updatedAt, runOn: blast.runOn, runOnChangedAt: blast.runOnChangedAt },
    counts: { total: Object.values(counts).reduce((n: number, v) => n + (v as number), 0), ...counts, REPLIED: replied },
    stats: {
      messagesSent: groupTotals.find((g) => g.status === 'SENT')?._count._all ?? 0,
      messagesTotal: groupTotals.reduce((n, g) => n + g._count._all, 0),
      opens: groupTotals.reduce((n, g) => n + (g._sum.openCount ?? 0), 0),
      openedRecruiters,
    },
    groups,
    sentByMailbox,
  });
});
