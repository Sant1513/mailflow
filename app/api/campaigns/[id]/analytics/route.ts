import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { EmailJobStatus, Prisma } from '@prisma/client';
import {
  SORTS, parseSort, sortInMemory, summariseOpeners, summariseClickers, topLinks, hourBuckets, median, countBy, deviceOf, mailClientOf, speedBands,
  type AnalyticsTab,
} from '@/lib/campaigns/analytics';

const SIZES = [25, 50, 100, 200];

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
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const reqSize = Number(url.searchParams.get('pageSize') ?? '50');
  const pageSize = SIZES.includes(reqSize) ? reqSize : 50;
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);

  const campaign = await prisma.campaign.findFirst({
    where: { id, workspaceId: session.workspaceId },
    select: { id: true },
  });
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // ── Aggregate stats ───────────────────────────────────────────────────────
  const [jobGroups, bouncedCount, openEvents, clickEvents, sentJobs, failedJobs] = await Promise.all([
    prisma.emailJob.groupBy({ by: ['status'], where: { campaignId: id }, _count: { _all: true } }),
    prisma.emailSuppression.count({ where: { campaignId: id, source: 'BOUNCE' } }),
    prisma.emailTrackingEvent.findMany({ where: { automated: false, campaignId: id, type: 'OPEN' }, select: { email: true, createdAt: true, userAgent: true } }),
    prisma.emailTrackingEvent.findMany({ where: { automated: false, campaignId: id, type: 'CLICK' }, select: { email: true, createdAt: true, url: true, userAgent: true } }),
    prisma.emailJob.findMany({ where: { campaignId: id, status: EmailJobStatus.SENT }, select: { toEmail: true, sentAt: true } }),
    prisma.emailJob.findMany({ where: { campaignId: id, status: EmailJobStatus.FAILED }, select: { lastAttemptAt: true } }),
  ]);

  const countJob = (status: EmailJobStatus) => jobGroups.find((g) => g.status === status)?._count._all ?? 0;
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
  const repliedCount = threadIds.length ? await prisma.conversation.count({ where: { gmailThreadId: { in: threadIds } } }) : 0;

  const sentAtByEmail = new Map<string, Date>();
  for (const j of sentJobs) if (j.sentAt) sentAtByEmail.set(j.toEmail.toLowerCase(), j.sentAt);

  const openers = summariseOpeners(openEvents, sentAtByEmail, clickEvents);
  const clickers = summariseClickers(clickEvents);
  const uniqueOpeners = openers.length;
  const uniqueClickers = clickers.length;
  const rate = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);
  const secs = openers.map((o) => o.secondsToFirstOpen).filter((s): s is number => s !== null);
  const delivered = Math.max(0, sent - bouncedCount);

  const stats = {
    audience,
    sent,
    failed,
    skipped,
    opens: uniqueOpeners,
    clicks: uniqueClickers,
    bounced: bouncedCount,
    replied: repliedCount,
    openRate: rate(uniqueOpeners, sent),
    clickRate: rate(uniqueClickers, sent),
    replyRate: rate(repliedCount, sent),
    failureRate: rate(failed, audience),
    // Advanced
    totalOpens: openEvents.length,
    totalClicks: clickEvents.length,
    delivered,
    unopened: Math.max(0, sent - uniqueOpeners),
    avgOpensPerOpener: uniqueOpeners ? Math.round((openEvents.length / uniqueOpeners) * 10) / 10 : 0,
    repeatOpeners: openers.filter((o) => o.opens > 1).length,
    clickToOpenRate: rate(uniqueClickers, uniqueOpeners),
    bounceRate: rate(bouncedCount, sent),
    medianSecondsToOpen: median(secs),
  };

  // ── Insights (overview) ───────────────────────────────────────────────────
  const insights = {
    opensByHour: hourBuckets(openEvents.map((e) => e.createdAt)),
    clicksByHour: hourBuckets(clickEvents.map((e) => e.createdAt)),
    devices: countBy(openers, (o) => o.device),
    clients: countBy(openers, (o) => o.client),
    speed: speedBands(secs),
    topLinks: topLinks(clickEvents, 10),
    // clicks of links with a person who never opened (images blocked): honest note, not a bug
    clickedWithoutOpen: clickers.filter((c) => !openers.some((o) => o.email === c.email)).length,
  };
  void deviceOf; void mailClientOf;

  // ── Trend series ──────────────────────────────────────────────────────────
  const sentDays = bucketByDay(sentJobs.map((r) => r.sentAt));
  const failedDays = bucketByDay(failedJobs.map((r) => r.lastAttemptAt));
  const openDays = bucketByDay(openEvents.map((r) => r.createdAt));
  const clickDays = bucketByDay(clickEvents.map((r) => r.createdAt));
  const allDays = new Set([...sentDays.keys(), ...failedDays.keys(), ...openDays.keys(), ...clickDays.keys()]);
  const trend = [...allDays].sort().map((day) => ({ day, sent: sentDays.get(day) ?? 0, failed: failedDays.get(day) ?? 0, opens: openDays.get(day) ?? 0, clicks: clickDays.get(day) ?? 0 }));

  // ── Tab rows: search (q), sort and paging happen here so large campaigns stay light ─────────────────
  let tabData: { rows: unknown[]; total: number; page: number; pageSize: number; sort: { key: string; dir: string }; q: string } | null = null;
  if (tab in SORTS) {
    const t = tab as AnalyticsTab;
    const sort = parseSort(t, url.searchParams.get('sort'), url.searchParams.get('dir'));
    const skip = (page - 1) * pageSize;
    const dbOrder = { [sort.key]: sort.dir } as Record<string, 'asc' | 'desc'>;
    const contains = (field: string) => ({ [field]: { contains: q, mode: 'insensitive' as const } });

    if (t === 'sent') {
      const where: Prisma.EmailJobWhereInput = { campaignId: id, status: EmailJobStatus.SENT, ...(q ? { OR: [contains('toEmail'), contains('subject')] } : {}) };
      const [rows, total] = await Promise.all([
        prisma.emailJob.findMany({ where, orderBy: dbOrder, skip, take: pageSize, select: { id: true, toEmail: true, subject: true, sentAt: true } }),
        prisma.emailJob.count({ where }),
      ]);
      tabData = { rows, total, page, pageSize, sort, q };
    } else if (t === 'failed') {
      const where: Prisma.EmailJobWhereInput = { campaignId: id, status: EmailJobStatus.FAILED, ...(q ? { OR: [contains('toEmail'), contains('errorMessage'), contains('errorCode')] } : {}) };
      const [rows, total] = await Promise.all([
        prisma.emailJob.findMany({ where, orderBy: dbOrder, skip, take: pageSize, select: { id: true, toEmail: true, errorCode: true, errorMessage: true, lastAttemptAt: true } }),
        prisma.emailJob.count({ where }),
      ]);
      tabData = { rows, total, page, pageSize, sort, q };
    } else if (t === 'replied') {
      if (!threadIds.length) tabData = { rows: [], total: 0, page, pageSize, sort, q };
      else {
        const where: Prisma.ConversationWhereInput = { gmailThreadId: { in: threadIds }, ...(q ? { OR: [contains('recipientEmail'), contains('subject')] } : {}) };
        const [rows, total] = await Promise.all([
          prisma.conversation.findMany({ where, orderBy: dbOrder, skip, take: pageSize, select: { id: true, recipientEmail: true, subject: true, createdAt: true, status: true } }),
          prisma.conversation.count({ where }),
        ]);
        tabData = { rows, total, page, pageSize, sort, q };
      }
    } else {
      const needle = q.toLowerCase();
      const match = (email: string) => !needle || email.toLowerCase().includes(needle);
      let all: Record<string, unknown>[];
      if (t === 'read') all = openers.filter((o) => match(o.email)) as unknown as Record<string, unknown>[];
      else if (t === 'clicked') all = clickers.filter((c) => match(c.email)) as unknown as Record<string, unknown>[];
      else {
        const opened = new Set(openers.map((o) => o.email));
        all = [...sentAtByEmail.entries()].filter(([email]) => !opened.has(email) && match(email)).map(([email, at]) => ({ email, sentAt: at }));
      }
      const sorted = sortInMemory(all, sort.key, sort.dir as 'asc' | 'desc');
      tabData = { rows: sorted.slice(skip, skip + pageSize), total: sorted.length, page, pageSize, sort, q };
    }
  }

  return NextResponse.json({ stats, insights, trend, tabData });
});
