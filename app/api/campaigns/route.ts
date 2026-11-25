import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId, requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { latestVersionOf } from '@/lib/templates/access';
import { CampaignStatus } from '@prisma/client';
import { snapshotFromTemplate } from '@/lib/documents/campaign';
import { MAX_DOCUMENTS_PER_CAMPAIGN } from '@/lib/documents/types';

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
      _count: { select: { documents: true } },
      batches: { select: { id: true, label: true, status: true, sentCount: true, failedCount: true, total: true } },
    },
  });

  const ids = campaigns.map((c) => c.id);
  // Per person (campaign + email + type): the number of events is that person's opens/clicks, the number of groups is the unique people.
  const trackingGroups = ids.length
    ? await prisma.emailTrackingEvent.groupBy({
        by: ['campaignId', 'type', 'email'],
        where: { automated: false, campaignId: { in: ids } },
        _count: { _all: true },
      })
    : [];
  const totals = new Map<string, { total: number; unique: number }>();
  for (const g of trackingGroups) {
    const k = `${g.campaignId}|${g.type}`;
    const t = totals.get(k) ?? { total: 0, unique: 0 };
    t.total += g._count._all; t.unique += 1; totals.set(k, t);
  }
  const countTracking = (id: string, type: string) => totals.get(`${id}|${type}`) ?? { total: 0, unique: 0 };

  const enriched = campaigns.map((c) => {
    const sent = c.batches.reduce((s, b) => s + b.sentCount, 0);
    const o = countTracking(c.id, 'OPEN');
    const k = countTracking(c.id, 'CLICK');
    return {
      ...c,
      tracking: {
        /** Unique people who opened / clicked (the rate is based on these). */
        opens: o.unique,
        clicks: k.unique,
        /** Every open / click, repeats included. */
        totalOpens: o.total,
        totalClicks: k.total,
        sent,
        openRate: sent > 0 ? Math.round((o.unique / sent) * 100) : null,
        clickRate: sent > 0 ? Math.round((k.unique / sent) * 100) : null,
      },
    };
  });

  return NextResponse.json({ campaigns: enriched });
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
  /** Personalised documents (library ids) to attach; each is snapshotted at creation. */
  documentTemplateIds: z.array(z.string()).max(MAX_DOCUMENTS_PER_CAMPAIGN).default([]),
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

  const documentIds = Array.from(new Set(body.documentTemplateIds));
  const documentTemplates = documentIds.length
    ? await prisma.documentTemplate.findMany({ where: { id: { in: documentIds }, workspaceId, archived: false } })
    : [];
  if (documentTemplates.length !== documentIds.length) {
    return NextResponse.json({ error: 'One or more documents were not found in this workspace, or are archived.' }, { status: 400 });
  }
  const orderedDocuments = documentIds.map((id) => documentTemplates.find((d) => d.id === id)!);

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
      orgUnitId: session.orgUnitId ?? null,
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
      documents: {
        create: orderedDocuments.map((d, i) => ({ documentTemplateId: d.id, order: i, ...snapshotFromTemplate(d) })),
      },
    },
  });

  await audit(session, 'CAMPAIGN_CREATE', {
    targetType: 'Campaign',
    targetId: campaign.id,
    metadata: orderedDocuments.length ? { documents: orderedDocuments.map((d) => d.name) } : undefined,
  });

  return NextResponse.json({ campaign }, { status: 201 });
});
