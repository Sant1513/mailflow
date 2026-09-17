import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { EmailJobStatus } from '@prisma/client';

const PAGE_SIZE = 50;

function bucketByDay(dates: (Date | null | undefined)[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of dates) {
    if (!d) continue;
    const key = d.toISOString().slice(0, 10);
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

export const GET = withErrorHandling(async (req, { params }) => {
  const session = await requireSession();
  const { id } = params as { id: string };
  if (!session.workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 403 });

  const url = new URL(req.url);
  const tab = url.searchParams.get('tab') ?? 'overview';
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));

  const campaign = await prisma.campaign.findFirst({
    where: { id, workspaceId: session.workspaceId },
    select: { id: true },
  });
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // ── Aggregate stats ───────────────────────────────────────────────────────
  const [jobGroups, bouncedCount, uniqueOpeners, uniqueClickers] = await Promise.all([
    prisma.emailJob.groupBy({
      by: ['status'],
      where: { campaignId: id },
      _count: { _all: true },
    }),
    prisma.emailSuppression.count({ where: { campaignId: id, source: 'BOUNCE' } }),
    prisma.emailTrackingEvent.findMany({
      where: { campaignId: id, type: 'OPEN' },
      distinct: ['email'],
      select: { email: true },
    }).then((r) => r.length),
    prisma.emailTrackingEvent.findMany({
      where: { campaignId: id, type: 'CLICK' },
      distinct: ['email'],
      select: { email: true },
    }).then((r) => r.length),
  ]);

  const countJob = (status: EmailJobStatus) =>
    jobGroups.find((g) => g.status === status)?._count._all ?? 0;

  const audience = jobGroups.reduce((s, g) => s + g._count._all, 0);
  const sent = countJob(EmailJobStatus.SENT);
  const failed = countJob(EmailJobStatus.FAILED);
  const skipped = countJob(EmailJobStatus.SKIPPED);

  // Replies via thread linkage
  const threadJobs = await prisma.emailJob.findMany({
    where: { campaignId: id, gmailThreadId: { not: null } },
    select: { gmailThreadId: true },
    distinct: ['gmailThreadId'],
  });
  const threadIds = threadJobs.map((j) => j.gmailThreadId!).filter(Boolean);
  const repliedCount = threadIds.length
    ? await prisma.conversation.count({ where: { gmailThreadId: { in: threadIds } } })
    : 0;

  const stats = {
    audience,
    sent,
    failed,
    skipped,
    opens: uniqueOpeners,
    clicks: uniqueClickers,
    bounced: bouncedCount,
    replied: repliedCount,
    openRate: sent > 0 ? Math.round((uniqueOpeners / sent) * 100) : 0,
    clickRate: sent > 0 ? Math.round((uniqueClickers / sent) * 100) : 0,
    replyRate: sent > 0 ? Math.round((repliedCount / sent) * 100) : 0,
    failureRate: audience > 0 ? Math.round((failed / audience) * 100) : 0,
  };

  // ── Trend series ──────────────────────────────────────────────────────────
  const [sentJobs, failedJobs, openEvents, clickEvents] = await Promise.all([
    prisma.emailJob.findMany({
      where: { campaignId: id, status: EmailJobStatus.SENT },
      select: { sentAt: true },
    }),
    prisma.emailJob.findMany({
      where: { campaignId: id, status: EmailJobStatus.FAILED },
      select: { lastAttemptAt: true },
    }),
    prisma.emailTrackingEvent.findMany({
      where: { campaignId: id, type: 'OPEN' },
      select: { createdAt: true },
    }),
    prisma.emailTrackingEvent.findMany({
      where: { campaignId: id, type: 'CLICK' },
      select: { createdAt: true },
    }),
  ]);

  const sentDays = bucketByDay(sentJobs.map((r) => r.sentAt));
  const failedDays = bucketByDay(failedJobs.map((r) => r.lastAttemptAt));
  const openDays = bucketByDay(openEvents.map((r) => r.createdAt));
  const clickDays = bucketByDay(clickEvents.map((r) => r.createdAt));

  const allDays = new Set([...sentDays.keys(), ...failedDays.keys(), ...openDays.keys(), ...clickDays.keys()]);
  const trend = [...allDays].sort().map((day) => ({
    day,
    sent: sentDays.get(day) ?? 0,
    failed: failedDays.get(day) ?? 0,
    opens: openDays.get(day) ?? 0,
    clicks: clickDays.get(day) ?? 0,
  }));

  // ── Tab-specific rows ─────────────────────────────────────────────────────
  let tabData: { rows: unknown[]; total: number; page: number } | null = null;

  if (tab === 'sent') {
    const [rows, total] = await Promise.all([
      prisma.emailJob.findMany({
        where: { campaignId: id, status: EmailJobStatus.SENT },
        orderBy: { sentAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: { id: true, toEmail: true, subject: true, sentAt: true },
      }),
      prisma.emailJob.count({ where: { campaignId: id, status: EmailJobStatus.SENT } }),
    ]);
    tabData = { rows, total, page };
  } else if (tab === 'read') {
    const events = await prisma.emailTrackingEvent.findMany({
      where: { campaignId: id, type: 'OPEN' },
      orderBy: { createdAt: 'asc' },
      select: { email: true, createdAt: true },
    });
    const emailMap = new Map<string, Date>();
    for (const e of events) {
      if (!emailMap.has(e.email)) emailMap.set(e.email, e.createdAt);
    }
    const all = [...emailMap.entries()].sort((a, b) => b[1].getTime() - a[1].getTime());
    const rows = all
      .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
      .map(([email, openedAt]) => ({ email, openedAt }));
    tabData = { rows, total: all.length, page };
  } else if (tab === 'clicked') {
    const events = await prisma.emailTrackingEvent.findMany({
      where: { campaignId: id, type: 'CLICK' },
      orderBy: { createdAt: 'asc' },
      select: { email: true, url: true, createdAt: true },
    });
    const emailMap = new Map<string, { url: string | null; clickedAt: Date }>();
    for (const e of events) {
      if (!emailMap.has(e.email)) emailMap.set(e.email, { url: e.url, clickedAt: e.createdAt });
    }
    const all = [...emailMap.entries()].sort((a, b) => b[1].clickedAt.getTime() - a[1].clickedAt.getTime());
    const rows = all
      .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
      .map(([email, data]) => ({ email, url: data.url, clickedAt: data.clickedAt }));
    tabData = { rows, total: all.length, page };
  } else if (tab === 'replied') {
    if (threadIds.length) {
      const [rows, total] = await Promise.all([
        prisma.conversation.findMany({
          where: { gmailThreadId: { in: threadIds } },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
          select: { id: true, recipientEmail: true, subject: true, createdAt: true, status: true },
        }),
        prisma.conversation.count({ where: { gmailThreadId: { in: threadIds } } }),
      ]);
      tabData = { rows, total, page };
    } else {
      tabData = { rows: [], total: 0, page };
    }
  } else if (tab === 'failed') {
    const [rows, total] = await Promise.all([
      prisma.emailJob.findMany({
        where: { campaignId: id, status: EmailJobStatus.FAILED },
        orderBy: { lastAttemptAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: { id: true, toEmail: true, errorCode: true, errorMessage: true, lastAttemptAt: true },
      }),
      prisma.emailJob.count({ where: { campaignId: id, status: EmailJobStatus.FAILED } }),
    ]);
    tabData = { rows, total, page };
  }

  return NextResponse.json({ stats, trend, tabData });
});
