import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';

/** Returns the Monday (UTC) that starts the ISO week containing `date`. */
function isoWeekStart(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay(); // 0=Sun … 6=Sat
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

function weekLabel(weekStart: Date): string {
  return weekStart.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const workspaceId = session.workspaceId;

  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace attached to your account.' }, { status: 400 });
  }

  const url = new URL(req.url);
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const from = url.searchParams.get('from') ? new Date(url.searchParams.get('from')!) : defaultFrom;
  const to = url.searchParams.get('to') ? new Date(url.searchParams.get('to')!) : now;

  const [signingRequests, campaignCount, emailJobs, trackingEvents, conversations] = await Promise.all([
    prisma.signingRequest.findMany({
      where: {
        workspaceId,
        sentAt: { gte: from, lte: to },
      },
      select: {
        status: true,
        sentAt: true,
        signedAt: true,
      },
    }),

    prisma.campaign.count({
      where: { workspaceId, createdAt: { gte: from, lte: to } },
    }),

    prisma.emailJob.findMany({
      where: {
        campaign: { workspaceId },
        sentAt: { gte: from, lte: to },
      },
      select: { status: true },
    }),

    prisma.emailTrackingEvent.findMany({
      where: {
        campaign: { workspaceId },
        createdAt: { gte: from, lte: to },
      },
      select: { type: true },
    }),

    prisma.conversation.findMany({
      where: {
        workspaceId,
        createdAt: { gte: from, lte: to },
      },
      select: { status: true },
    }),
  ]);

  // --- Signing metrics ---
  const sent = signingRequests.length;
  const signedReqs = signingRequests.filter((r) => r.status === 'SIGNED');
  const signed = signedReqs.length;
  const signRate = sent > 0 ? Math.round((signed / sent) * 100) : 0;

  const signedWithTimes = signedReqs.filter((r) => r.signedAt && r.sentAt);
  const avgTimeToSignHours =
    signedWithTimes.length > 0
      ? Math.round(
          signedWithTimes.reduce(
            (sum, r) => sum + (r.signedAt!.getTime() - r.sentAt!.getTime()) / (1000 * 60 * 60),
            0,
          ) / signedWithTimes.length,
        )
      : 0;

  const pendingCount = signingRequests.filter(
    (r) => r.status === 'SENT' || r.status === 'VIEWED',
  ).length;
  const expiredCount = signingRequests.filter((r) => r.status === 'EXPIRED').length;

  // --- byWeek: last 8 ISO weeks ending at/including 'to' ---
  const currentWeekStart = isoWeekStart(to);
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const start = new Date(currentWeekStart);
    start.setUTCDate(start.getUTCDate() - (7 - i) * 7);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    return { start, end, label: weekLabel(start) };
  });

  const byWeek = weeks.map(({ start, end, label }) => {
    const inWeek = signingRequests.filter(
      (r) => r.sentAt && r.sentAt >= start && r.sentAt < end,
    );
    return {
      week: label,
      sent: inWeek.length,
      signed: inWeek.filter((r) => r.status === 'SIGNED').length,
    };
  });

  // --- Campaign metrics ---
  const emailsSent = emailJobs.filter((j) => j.status === 'SENT').length;
  const emailsFailed = emailJobs.filter((j) => j.status === 'FAILED').length;
  const totalEmails = emailJobs.length;
  const opens = trackingEvents.filter((e) => e.type === 'OPEN').length;
  const clicks = trackingEvents.filter((e) => e.type === 'CLICK').length;
  const openRate = emailsSent > 0 ? Math.round((opens / emailsSent) * 100) : 0;
  const clickRate = emailsSent > 0 ? Math.round((clicks / emailsSent) * 100) : 0;
  const failureRate = totalEmails > 0 ? Math.round((emailsFailed / totalEmails) * 100) : 0;

  // --- Inbox metrics ---
  const totalConversations = conversations.length;
  const openCount = conversations.filter(
    (c) => c.status === 'OPEN' || c.status === 'IN_PROGRESS' || c.status === 'WAITING_FOR_STUDENT',
  ).length;
  const resolvedCount = conversations.filter(
    (c) => c.status === 'RESOLVED' || c.status === 'CLOSED',
  ).length;
  const resolutionRate =
    totalConversations > 0 ? Math.round((resolvedCount / totalConversations) * 100) : 0;

  return NextResponse.json({
    period: { from: from.toISOString(), to: to.toISOString() },
    signing: {
      sent,
      signed,
      signRate,
      avgTimeToSignHours,
      pendingCount,
      expiredCount,
      byWeek,
    },
    campaigns: {
      total: campaignCount,
      emailsSent,
      openRate,
      clickRate,
      failureRate,
    },
    inbox: {
      totalConversations,
      openCount,
      resolvedCount,
      resolutionRate,
    },
  });
});
