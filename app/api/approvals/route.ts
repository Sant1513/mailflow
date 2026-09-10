import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { CampaignStatus, Role } from '@prisma/client';
import { reviewScope } from '@/lib/permissions/reviewer';

/**
 * §36 approvals inbox. SUPER_ADMIN sees the whole organisation; ADMIN sees
 * their workspace. `?status=pending|approved|rejected|all` and `?q=` search
 * over campaign name, requester and workspace.
 */
const STATUS_FILTER: Record<string, CampaignStatus[] | null> = {
  pending: [CampaignStatus.PENDING_APPROVAL],
  approved: [CampaignStatus.APPROVED, CampaignStatus.SCHEDULED, CampaignStatus.RUNNING, CampaignStatus.PAUSED, CampaignStatus.COMPLETED, CampaignStatus.PARTIALLY_FAILED],
  rejected: [CampaignStatus.REJECTED],
  all: null,
};

export const GET = withErrorHandling(async (req) => {
  const session = await requireRole([Role.ADMIN, Role.SUPER_ADMIN]);
  const url = new URL(req.url);
  const status = url.searchParams.get('status') ?? 'pending';
  const q = (url.searchParams.get('q') ?? '').trim();
  const statuses = STATUS_FILTER[status] ?? STATUS_FILTER.pending!;

  const scope = await reviewScope(session);

  const campaigns = await prisma.campaign.findMany({
    where: {
      ...scope,
      // "all" still means "has been through the workflow" — drafts are not requests.
      ...(statuses ? { status: { in: statuses } } : { submittedAt: { not: null } }),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { createdBy: { name: { contains: q, mode: 'insensitive' } } },
              { createdBy: { email: { contains: q, mode: 'insensitive' } } },
              { workspace: { name: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    orderBy: [{ submittedAt: 'desc' }, { updatedAt: 'desc' }],
    take: 200,
    select: {
      id: true,
      name: true,
      status: true,
      submittedAt: true,
      approvedAt: true,
      rejectedAt: true,
      rejectionReason: true,
      approvalRemarks: true,
      approvalRequestEmail: true,
      approvalDecisionEmail: true,
      createdById: true,
      reviewedById: true,
      updatedAt: true,
      workspace: { select: { id: true, name: true } },
      dataset: { select: { name: true } },
      template: { select: { name: true } },
      templateVersion: { select: { version: true, subject: true } },
      createdBy: { select: { id: true, name: true, email: true } },
      _count: { select: { campaignRecords: true } },
    },
  });

  const reviewerIds = Array.from(new Set(campaigns.map((c) => c.reviewedById).filter((x): x is string => !!x)));
  const reviewers = reviewerIds.length
    ? await prisma.user.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, name: true } })
    : [];
  const reviewerName = new Map(reviewers.map((r) => [r.id, r.name]));

  const counts = await prisma.campaign.groupBy({
    by: ['status'],
    where: { ...scope, status: { in: [CampaignStatus.PENDING_APPROVAL, CampaignStatus.REJECTED, CampaignStatus.APPROVED] } },
    _count: { _all: true },
  });
  const count = (s: CampaignStatus) => counts.find((c) => c.status === s)?._count._all ?? 0;

  return NextResponse.json({
    scope: session.role === Role.SUPER_ADMIN ? 'organization' : 'workspace',
    counts: { pending: count(CampaignStatus.PENDING_APPROVAL), approved: count(CampaignStatus.APPROVED), rejected: count(CampaignStatus.REJECTED) },
    requests: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      workspace: c.workspace,
      requester: c.createdBy,
      dataset: c.dataset.name,
      recipients: c._count.campaignRecords,
      template: `${c.template.name} v${c.templateVersion.version}`,
      subjectLine: c.templateVersion.subject,
      submittedAt: c.submittedAt,
      decidedAt: c.approvedAt ?? c.rejectedAt ?? null,
      reviewer: c.reviewedById ? reviewerName.get(c.reviewedById) ?? null : null,
      reason: c.rejectionReason,
      remarks: c.approvalRemarks,
      requestEmail: c.approvalRequestEmail,
      decisionEmail: c.approvalDecisionEmail,
      canDecide: c.status === CampaignStatus.PENDING_APPROVAL && (c.createdById !== session.userId || session.role === Role.SUPER_ADMIN),
      isOwn: c.createdById === session.userId,
    })),
  });
});
