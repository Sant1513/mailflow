import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { emailColumnKeyOf, loadCampaignForSession, senderAccountFor } from '@/lib/campaigns/context';
import { FILE_META_SELECT, inspectionOf, previewDocument, systemValuesFor } from '@/lib/documents/campaign';
import { PREVIEW_REFERENCE } from '@/lib/documents/reference';

export const maxDuration = 30;

const schema = z.object({ recordId: z.string().optional() });

/**
 * The exact PDF one recipient of this campaign would receive, generated from
 * the campaign's snapshot with the campaign's sender. Nothing is stored or
 * sent; the reference reads MF-PREVIEW instead of the real per-email id.
 */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string; docId: string } }) => {
  const session = await requireSession();
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const body = schema.parse(await req.json().catch(() => ({})));

  const doc = await prisma.campaignDocument.findFirst({
    where: { id: params.docId, campaignId: campaign.id },
    include: { file: { select: FILE_META_SELECT } },
  });
  if (!doc) return NextResponse.json({ error: 'Document not attached to this campaign.' }, { status: 404 });

  const record = body.recordId
    ? await prisma.record.findFirst({ where: { id: body.recordId, datasetId: campaign.datasetId }, select: { id: true, data: true } })
    : await prisma.record.findFirst({ where: { datasetId: campaign.datasetId }, orderBy: { createdAt: 'asc' }, select: { id: true, data: true } });
  if (body.recordId && !record) return NextResponse.json({ error: 'That record is not in this campaign’s dataset.' }, { status: 404 });

  const data = record ? ((record.data ?? {}) as Record<string, unknown>) : null;
  const emailKey = emailColumnKeyOf(campaign.dataset);
  const rawEmail = data && emailKey ? data[emailKey] : null;
  const sender = await senderAccountFor(campaign);
  const now = new Date();
  const system = systemValuesFor(
    {
      campaignName: campaign.name,
      timezone: campaign.timezone,
      senderName: campaign.fromName?.trim() || sender?.displayName || campaign.createdBy.name,
      senderEmail: sender?.emailAddress ?? campaign.createdBy.email,
      now,
    },
    typeof rawEmail === 'string' && rawEmail.trim() ? rawEmail.trim() : null,
    PREVIEW_REFERENCE
  );

  const preview = await previewDocument(doc, { data, system, now, timezone: campaign.timezone, inspection: inspectionOf(doc.file) });
  return NextResponse.json({ preview, recordId: record?.id ?? null });
});
