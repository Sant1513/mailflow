import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CampaignStatus, EmailJobStatus } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadCampaignForSession, senderAccountFor } from '@/lib/campaigns/context';
import { availableFallbackMailboxes, fallbackOptIns, validateFallbackList } from '@/lib/campaigns/fallback';
import { kickSendWorker } from '@/lib/queue/sendWorker';

async function mainAccountOf(campaign: { senderAccountId: string | null; workspaceId: string; createdById: string }) {
  if (campaign.senderAccountId) {
    const a = await prisma.emailProviderAccount.findUnique({ where: { id: campaign.senderAccountId }, select: { id: true, emailAddress: true, status: true } });
    if (a) return a;
  }
  const a = await senderAccountFor(campaign);
  return a ? { id: a.id, emailAddress: a.emailAddress, status: a.status } : null;
}

/** GET — the campaign's backup mailboxes, the ones that can be added, and who sent how many emails. */
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const main = await mainAccountOf(campaign);
  const optIns = await fallbackOptIns(campaign.organizationId);
  const chosen = campaign.fallbackAccountIds.length
    ? await prisma.emailProviderAccount.findMany({
        where: { id: { in: campaign.fallbackAccountIds } },
        select: { id: true, emailAddress: true, status: true, user: { select: { name: true } } },
      })
    : [];
  const byId = new Map(chosen.map((c) => [c.id, c]));
  const selected = campaign.fallbackAccountIds
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map((c) => ({ id: c.id, emailAddress: c.emailAddress, ownerName: c.user.name, status: c.status, allowed: optIns.has(c.id) }));

  const sentGroups = await prisma.emailJob.groupBy({
    by: ['fromEmail'],
    where: { campaignId: campaign.id, status: EmailJobStatus.SENT },
    _count: true,
  });

  return NextResponse.json({
    main,
    selected,
    available: await availableFallbackMailboxes(campaign.organizationId, main?.id),
    sentBy: sentGroups.map((g) => ({ emailAddress: g.fromEmail, count: g._count })).sort((a, b) => b.count - a.count),
    editable: !([CampaignStatus.COMPLETED, CampaignStatus.CANCELLED] as CampaignStatus[]).includes(campaign.status),
  });
});

const putSchema = z.object({ accountIds: z.array(z.string().min(1)).max(5) });

/**
 * PUT — set the backup mailboxes, in order. Allowed while the campaign is
 * sending or paused, so a backup can be added the moment a limit is hit.
 */
export const PUT = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  if (session.viewingAs) return NextResponse.json({ error: 'Read-only while viewing as another user.' }, { status: 403 });
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (([CampaignStatus.COMPLETED, CampaignStatus.CANCELLED] as CampaignStatus[]).includes(campaign.status)) {
    return NextResponse.json({ error: `A ${campaign.status.toLowerCase()} campaign can't be changed.` }, { status: 409 });
  }

  const { accountIds } = putSchema.parse(await req.json());
  const main = await mainAccountOf(campaign);
  const checked = await validateFallbackList(campaign.organizationId, main?.id ?? null, accountIds);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  await prisma.campaign.update({ where: { id: campaign.id }, data: { fallbackAccountIds: checked.ids } });
  await audit(session, 'CAMPAIGN_FALLBACK_MAILBOXES', {
    targetType: 'Campaign',
    targetId: campaign.id,
    metadata: { from: campaign.fallbackAccountIds, to: checked.ids },
  });
  // A campaign that was on hold can carry on straight away from the new backup.
  if (checked.ids.length && ([CampaignStatus.RUNNING, CampaignStatus.SCHEDULED] as CampaignStatus[]).includes(campaign.status)) {
    kickSendWorker('fallback-added');
  }
  return NextResponse.json({ accountIds: checked.ids });
});
