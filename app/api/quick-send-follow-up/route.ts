import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { QUICK_SEND_DESCRIPTION } from '@/lib/quickSend/stats';

/**
 * Quick Send Follow-up tab. GET: your finished Quick Sends (any round) that can be followed up,
 * with sent / replied / opened counts, and the follow-ups made so far. The follow-up itself is
 * composed on the Quick Send screen (see /quick-send-follow-up/new) and sent through POST
 * /api/quick-send like any Quick Send.
 */
export const dynamic = 'force-dynamic';

const FINISHED = ['COMPLETED', 'PARTIALLY_FAILED'] as const;

export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  if (!session.workspaceId) return NextResponse.json({ sources: [], followUps: [] });
  const where = { workspaceId: session.workspaceId, description: QUICK_SEND_DESCRIPTION };
  const [finished, followUps] = await Promise.all([
    prisma.campaign.findMany({
      where: { ...where, status: { in: [...FINISHED] } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: 100,
      select: { id: true, name: true, status: true, round: true, rootCampaignId: true, createdAt: true, updatedAt: true, templateVersion: { select: { subject: true } } },
    }),
    prisma.campaign.findMany({
      where: { ...where, parentCampaignId: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 100,
      select: { id: true, name: true, status: true, round: true, parentCampaignId: true, followUpAudience: true, createdAt: true, scheduledAt: true, templateVersion: { select: { subject: true } } },
    }),
  ]);
  const ids = [...new Set([...finished.map((c) => c.id), ...followUps.map((c) => c.id)])];
  const parentIds = [...new Set(followUps.map((f) => f.parentCampaignId!))];
  const asCounts = (rows: { campaignId: string; n: bigint | number }[]) => new Map(rows.map((r) => [r.campaignId, Number(r.n)]));
  const [sentRows, openRows, replyRows, childRows, parents] = ids.length
    ? await Promise.all([
        prisma.$queryRaw<{ campaignId: string; n: bigint }[]>(Prisma.sql`SELECT "campaignId", COUNT(*) AS n FROM "EmailJob" WHERE "campaignId" = ANY(${ids}::text[]) AND "status" = 'SENT' GROUP BY "campaignId"`),
        prisma.$queryRaw<{ campaignId: string; n: bigint }[]>(Prisma.sql`SELECT "campaignId", COUNT(DISTINCT lower("email")) AS n FROM "EmailTrackingEvent" WHERE "campaignId" = ANY(${ids}::text[]) AND "type" = 'OPEN' AND "automated" = false GROUP BY "campaignId"`),
        prisma.$queryRaw<{ campaignId: string; n: bigint }[]>(Prisma.sql`
          SELECT j."campaignId", COUNT(DISTINCT j."gmailThreadId") AS n
          FROM "EmailJob" j JOIN "Conversation" c ON c."gmailThreadId" = j."gmailThreadId"
          WHERE j."campaignId" = ANY(${ids}::text[]) AND j."status" = 'SENT'
            AND EXISTS (SELECT 1 FROM "ConversationMessage" m WHERE m."conversationId" = c."id" AND m."direction" = 'INBOUND' AND m."classification" = 'HUMAN_REPLY')
          GROUP BY j."campaignId"`),
        prisma.campaign.groupBy({ by: ['parentCampaignId'], where: { parentCampaignId: { in: ids } }, _count: { _all: true } }),
        prisma.campaign.findMany({ where: { id: { in: parentIds } }, select: { id: true, name: true } }),
      ])
    : [[], [], [], [], []];
  const sent = asCounts(sentRows as never);
  const opened = asCounts(openRows as never);
  const replied = asCounts(replyRows as never);
  const stats = (id: string) => ({ sent: sent.get(id) ?? 0, opened: opened.get(id) ?? 0, replied: replied.get(id) ?? 0 });
  return NextResponse.json({
    sources: finished
      .map((c) => ({ id: c.id, name: c.name, subject: c.templateVersion.subject, round: c.round, status: c.status, finishedAt: c.updatedAt, ...stats(c.id), followUps: childRows.find((r) => r.parentCampaignId === c.id)?._count._all ?? 0 }))
      .filter((c) => c.sent > 0),
    followUps: followUps.map((f) => ({ id: f.id, name: f.name, subject: f.templateVersion.subject, round: f.round, status: f.status, followUpAudience: f.followUpAudience, createdAt: f.createdAt, scheduledAt: f.scheduledAt, parentName: parents.find((p) => p.id === f.parentCampaignId)?.name ?? null, ...stats(f.id) })),
  });
});
