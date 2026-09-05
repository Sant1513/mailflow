import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadCampaignForSession } from '@/lib/campaigns/context';
import { CampaignStatus, Role } from '@prisma/client';

/**
 * §36 Approval workflow: Draft → Pending Approval → Approved → Send.
 * Every transition is audited (§95).
 */
const actionSchema = z.object({
  action: z.enum(['SUBMIT', 'APPROVE', 'REJECT', 'REQUEST_CHANGES']),
  reason: z.string().max(2000).optional(),
});

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { action, reason } = actionSchema.parse(await req.json());

  if (action === 'SUBMIT') {
    if (campaign.status !== CampaignStatus.DRAFT && campaign.status !== CampaignStatus.REJECTED) {
      return NextResponse.json(
        { error: `Only a draft or rejected campaign can be submitted (this one is ${campaign.status}).` },
        { status: 400 }
      );
    }
    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: CampaignStatus.PENDING_APPROVAL, rejectionReason: null },
    });
    await audit(session, 'CAMPAIGN_SUBMITTED_FOR_APPROVAL', { targetType: 'Campaign', targetId: campaign.id });
    return NextResponse.json({ campaign: updated });
  }

  // Approving your own campaign defeats the purpose of review, so only
  // ADMIN/SUPER_ADMIN may approve, and never their own submission unless
  // they are a SUPER_ADMIN acting deliberately.
  if (session.role !== Role.ADMIN && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError('Only an admin can approve or reject a campaign.');
  }
  if (campaign.status !== CampaignStatus.PENDING_APPROVAL) {
    return NextResponse.json(
      { error: `Campaign is not awaiting approval (status: ${campaign.status}).` },
      { status: 400 }
    );
  }
  if (campaign.createdById === session.userId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError('You cannot approve a campaign you created.');
  }

  if (action === 'APPROVE') {
    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: CampaignStatus.APPROVED, approvedById: session.userId, approvedAt: new Date(), rejectionReason: null },
    });
    await audit(session, 'CAMPAIGN_APPROVED', {
      targetType: 'Campaign',
      targetId: campaign.id,
      metadata: { createdBy: campaign.createdById },
    });
    return NextResponse.json({ campaign: updated });
  }

  const updated = await prisma.campaign.update({
    where: { id: campaign.id },
    data: {
      status: action === 'REJECT' ? CampaignStatus.REJECTED : CampaignStatus.DRAFT,
      rejectionReason: reason ?? null,
    },
  });
  await audit(session, action === 'REJECT' ? 'CAMPAIGN_REJECTED' : 'CAMPAIGN_CHANGES_REQUESTED', {
    targetType: 'Campaign',
    targetId: campaign.id,
    metadata: { reason },
  });

  return NextResponse.json({ campaign: updated });
});
