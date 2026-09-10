import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId, requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { latestVersionOf } from '@/lib/templates/access';
import { CampaignStatus } from '@prisma/client';

export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));

  const campaigns = await prisma.campaign.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: 'desc' },
    include: {
      dataset: { select: { id: true, name: true, _count: { select: { records: true } } } },
      template: { select: { id: true, name: true } },
      templateVersion: { select: { version: true } },
      createdBy: { select: { name: true, email: true } },
      batches: { select: { id: true, label: true, status: true, sentCount: true, failedCount: true, total: true } },
    },
  });

  return NextResponse.json({ campaigns });
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  datasetId: z.string(),
  templateId: z.string(),
  /** Omit to pin the template's current latest version (§21). */
  templateVersionId: z.string().optional(),
  scheduledAt: z.string().datetime().optional(),
  timezone: z.string().default('Asia/Kolkata'),
  workspaceId: z.string().optional(),
});

export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  requireCanWrite(session);
  const body = createSchema.parse(await req.json());
  const workspaceId = await resolveWorkspaceId(session, body.workspaceId);

  const [dataset, template] = await Promise.all([
    prisma.dataset.findUnique({ where: { id: body.datasetId } }),
    prisma.template.findUnique({ where: { id: body.templateId }, include: { versions: true } }),
  ]);

  if (!dataset || dataset.workspaceId !== workspaceId) {
    return NextResponse.json({ error: 'Dataset not found in this workspace' }, { status: 404 });
  }
  if (!template || template.workspaceId !== workspaceId) {
    return NextResponse.json({ error: 'Template not found in this workspace' }, { status: 404 });
  }

  // §21/§126: the campaign pins ONE template version at creation. Later
  // edits to the template create new versions and never alter what this
  // campaign will send.
  let templateVersionId = body.templateVersionId;
  if (templateVersionId) {
    if (!template.versions.some((v) => v.id === templateVersionId)) {
      return NextResponse.json({ error: 'Template version does not belong to this template' }, { status: 400 });
    }
  } else {
    const latest = latestVersionOf(template.versions);
    if (!latest) return NextResponse.json({ error: 'Template has no versions yet' }, { status: 400 });
    templateVersionId = latest.id;
  }

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: session.organizationId,
      workspaceId,
      name: body.name,
      description: body.description,
      datasetId: dataset.id,
      templateId: template.id,
      templateVersionId,
      createdById: session.userId,
      status: body.scheduledAt ? CampaignStatus.SCHEDULED : CampaignStatus.DRAFT,
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
      timezone: body.timezone,
    },
  });

  await audit(session, 'CAMPAIGN_CREATE', { targetType: 'Campaign', targetId: campaign.id });

  return NextResponse.json({ campaign }, { status: 201 });
});
