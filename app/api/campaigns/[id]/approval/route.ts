import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadCampaignForSession } from '@/lib/campaigns/context';
import { sendApprovalDecisionEmail, sendApprovalRequestEmail } from '@/lib/campaigns/approvalEmails';
import { CampaignStatus, Role } from '@prisma/client';

/**
 * §36 Approval workflow: Draft → Pending Approval → Approved → Send.
 * Every transition is audited (§95). Submission emails the approvers with
 * the requester in Cc; the decision is emailed back in the same thread.
 * Email is best effort — see lib/campaigns/approvalEmails.ts.
 */
const actionSchema = z.object({
  action: z.enum(['SUBMIT', 'APPROVE', 'REJECT', 'REQUEST_CHANGES']),
  /** Shown to the requester. Required for REJECT. */
  reason: z.string().max(2000).optional(),
  /** Internal reviewer notes; never emailed. */
  remarks: z.string().max(2000).optional(),
});

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { action, reason, remarks } = actionSchema.parse(await req.json());

  if (action === 'SUBMIT') {
    if (campaign.status !== CampaignStatus.DRAFT && campaign.status !== CampaignStatus.REJECTED) {
      return NextResponse.json(
        { error: `Only a draft or rejected campaign can be submitted (this one is ${campaign.status}).` },
        { status: 400 }
      );
    }
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        status: CampaignStatus.PENDING_APPROVAL,
        rejectionReason: null,
        rejectedAt: null,
        approvalRemarks: null,
        submittedAt: new Date(),
        approvalDecisionEmail: null,
      },
    });
    await audit(session, 'CAMPAIGN_SUBMITTED_FOR_APPROVAL', { targetType: 'Campaign', targetId: campaign.id });
    const emailStatus = await sendApprovalRequestEmail(campaign.id, session);
    const updated = await prisma.campaign.findUnique({ where: { id: campaign.id } });
    return NextResponse.json({ campaign: updated, emailStatus });
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
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        status: CampaignStatus.APPROVED,
        approvedById: session.userId,
        reviewedById: session.userId,
        approvedAt: new Date(),
        rejectionReason: null,
        approvalRemarks: remarks?.trim() || null,
      },
    });
    await audit(session, 'CAMPAIGN_APPROVED', {
      targetType: 'Campaign',
      targetId: campaign.id,
      metadata: { createdBy: campaign.createdById, remarks: remarks?.trim() || undefined },
    });
    const emailStatus = await sendApprovalDecisionEmail(campaign.id, 'APPROVED', session);
    const updated = await prisma.campaign.findUnique({ where: { id: campaign.id } });
    return NextResponse.json({ campaign: updated, emailStatus });
  }

  if (action === 'REJECT' && !reason?.trim()) {
    return NextResponse.json({ error: 'A reason is required to reject a campaign — the requester sees it.' }, { status: 400 });
  }

  await prisma.campaign.update({
    where: { id: campaign.id },
    data: {
      status: action === 'REJECT' ? CampaignStatus.REJECTED : CampaignStatus.DRAFT,
      rejectionReason: reason?.trim() || null,
      rejectedAt: action === 'REJECT' ? new Date() : null,
      reviewedById: session.userId,
      approvalRemarks: remarks?.trim() || null,
    },
  });
  await audit(session, action === 'REJECT' ? 'CAMPAIGN_REJECTED' : 'CAMPAIGN_CHANGES_REQUESTED', {
    targetType: 'Campaign',
    targetId: campaign.id,
    metadata: { reason, remarks: remarks?.trim() || undefined },
  });
  const emailStatus = action === 'REJECT' ? await sendApprovalDecisionEmail(campaign.id, 'REJECTED', session, reason) : null;
  const updated = await prisma.campaign.findUnique({ where: { id: campaign.id } });
  return NextResponse.json({ campaign: updated, emailStatus });
});
