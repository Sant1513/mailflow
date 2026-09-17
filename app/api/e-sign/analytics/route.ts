import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';

/** GET /api/e-sign/analytics — signing analytics for the current workspace. */
export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  if (!session.workspaceId) {
    return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  }
  const workspaceId = session.workspaceId;

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Fetch all signing requests for totals and trend (last 30 days)
  const [allRequests, recentActivity] = await Promise.all([
    prisma.signingRequest.findMany({
      where: { workspaceId },
      select: {
        status: true,
        sentAt: true,
        signedAt: true,
      },
    }),
    prisma.signingRequest.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        title: true,
        recipientName: true,
        recipientEmail: true,
        status: true,
        signedAt: true,
        sentAt: true,
      },
    }),
  ]);

  // Totals
  const totals = {
    sent: allRequests.filter((r) => r.status !== 'DRAFT').length,
    viewed: allRequests.filter((r) => r.status === 'VIEWED').length,
    signed: allRequests.filter((r) => r.status === 'SIGNED').length,
    expired: allRequests.filter((r) => r.status === 'EXPIRED').length,
    voided: allRequests.filter((r) => r.status === 'VOIDED').length,
  };

  // Sign rate: signed / sent * 100
  const signRate = totals.sent > 0 ? Math.round((totals.signed / totals.sent) * 100) : 0;

  // Average time to sign (in hours)
  const signedWithTimes = allRequests.filter(
    (r) => r.status === 'SIGNED' && r.signedAt && r.sentAt
  );
  const avgTimeToSignHours =
    signedWithTimes.length > 0
      ? signedWithTimes.reduce((sum, r) => {
          const diffMs = r.signedAt!.getTime() - r.sentAt!.getTime();
          return sum + diffMs / (1000 * 60 * 60);
        }, 0) / signedWithTimes.length
      : 0;

  // 30-day trend: bucket by sentAt day (sent count) and signedAt day (signed count)
  const trendMap = new Map<string, { sent: number; signed: number }>();

  // Initialise all 30 days
  for (let i = 0; i < 30; i++) {
    const d = new Date(thirtyDaysAgo.getTime() + i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    trendMap.set(key, { sent: 0, signed: 0 });
  }

  for (const r of allRequests) {
    if (r.sentAt && r.sentAt >= thirtyDaysAgo) {
      const key = r.sentAt.toISOString().slice(0, 10);
      const entry = trendMap.get(key);
      if (entry) entry.sent++;
    }
    if (r.signedAt && r.signedAt >= thirtyDaysAgo) {
      const key = r.signedAt.toISOString().slice(0, 10);
      const entry = trendMap.get(key);
      if (entry) entry.signed++;
    }
  }

  const trend = Array.from(trendMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, counts]) => ({ day, ...counts }));

  return NextResponse.json({
    totals,
    signRate,
    avgTimeToSignHours: Math.round(avgTimeToSignHours * 10) / 10,
    trend,
    recentActivity,
  });
});
