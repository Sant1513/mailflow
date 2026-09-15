import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadCampaignForSession } from '@/lib/campaigns/context';
import { canEditIn, requireOwnWorkspace } from '@/lib/documents/access';
import {
  DOCUMENT_EDITABLE_STATUSES,
  FILE_META_SELECT,
  documentsLockedMessage,
  inspectionOf,
  snapshotDrift,
  snapshotFromTemplate,
} from '@/lib/documents/campaign';
import { checkDocumentConfig } from '@/lib/documents/checks';
import { MAX_DOCUMENTS_PER_CAMPAIGN, parseFields } from '@/lib/documents/types';
import { Prisma } from '@prisma/client';

/** Personalised documents attached to a campaign, with what changed in the library since each snapshot. */
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const rows = await prisma.campaignDocument.findMany({
    where: { campaignId: campaign.id },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    include: {
      file: { select: FILE_META_SELECT },
      documentTemplate: {
        select: { id: true, name: true, fileId: true, fields: true, fileNamePattern: true, lockMode: true, stampReference: true, archived: true },
      },
    },
  });
  const columnKeys = campaign.dataset.columns.map((c) => c.key);

  return NextResponse.json({
    documents: rows.map((d) => {
      const fields = parseFields(d.fields);
      return {
        id: d.id,
        documentTemplateId: d.documentTemplateId,
        name: d.name,
        fileName: d.file.fileName,
        pageCount: d.file.pageCount,
        size: d.file.size,
        fields: fields.map((f) => ({ id: f.id, label: f.label, value: f.value, required: f.required })),
        fileNamePattern: d.fileNamePattern,
        lockMode: d.lockMode,
        stampReference: d.stampReference,
        snapshotAt: d.snapshotAt,
        drift: snapshotDrift(d, d.documentTemplate),
        libraryArchived: d.documentTemplate.archived,
        issues: checkDocumentConfig({ fields, fileNamePattern: d.fileNamePattern }, inspectionOf(d.file), columnKeys),
      };
    }),
    editable: DOCUMENT_EDITABLE_STATUSES.includes(campaign.status) && canEditIn(session, campaign.workspaceId),
    lockedReason: DOCUMENT_EDITABLE_STATUSES.includes(campaign.status) ? null : documentsLockedMessage(campaign.status),
    maxDocuments: MAX_DOCUMENTS_PER_CAMPAIGN,
  });
});

const addSchema = z.object({ documentTemplateId: z.string().min(1) });

/** Attaches a library document by taking a snapshot of it. */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  requireOwnWorkspace(session, campaign.workspaceId);
  if (!DOCUMENT_EDITABLE_STATUSES.includes(campaign.status)) {
    return NextResponse.json({ error: documentsLockedMessage(campaign.status) }, { status: 409 });
  }

  const { documentTemplateId } = addSchema.parse(await req.json());
  const template = await prisma.documentTemplate.findUnique({ where: { id: documentTemplateId } });
  if (!template || template.workspaceId !== campaign.workspaceId) {
    return NextResponse.json({ error: 'Document not found in this workspace.' }, { status: 404 });
  }
  if (template.archived) {
    return NextResponse.json({ error: 'This document is archived. Restore it in Documents first.' }, { status: 400 });
  }

  const existing = await prisma.campaignDocument.findMany({ where: { campaignId: campaign.id }, select: { documentTemplateId: true } });
  if (existing.some((e) => e.documentTemplateId === template.id)) {
    return NextResponse.json({ error: 'This document is already attached to the campaign.' }, { status: 409 });
  }
  if (existing.length >= MAX_DOCUMENTS_PER_CAMPAIGN) {
    return NextResponse.json({ error: `A campaign can attach at most ${MAX_DOCUMENTS_PER_CAMPAIGN} documents.` }, { status: 400 });
  }

  try {
    const created = await prisma.campaignDocument.create({
      data: { campaignId: campaign.id, documentTemplateId: template.id, order: existing.length, ...snapshotFromTemplate(template) },
      select: { id: true },
    });
    await audit(session, 'CAMPAIGN_DOCUMENT_ADD', {
      targetType: 'Campaign',
      targetId: campaign.id,
      metadata: { campaignDocumentId: created.id, documentTemplateId: template.id, name: template.name },
    });
    return NextResponse.json({ document: created }, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return NextResponse.json({ error: 'This document is already attached to the campaign.' }, { status: 409 });
    }
    throw err;
  }
});
