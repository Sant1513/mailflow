import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadCampaignForSession } from '@/lib/campaigns/context';
import { requireOwnWorkspace } from '@/lib/documents/access';
import { DOCUMENT_EDITABLE_STATUSES, documentsLockedMessage, snapshotDrift, snapshotFromTemplate } from '@/lib/documents/campaign';

type Params = { params: { id: string; docId: string } };

async function loadForChange(req: Request, { params }: Params) {
  const session = await requireSession();
  requireCanWrite(session);
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return { response: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  requireOwnWorkspace(session, campaign.workspaceId);
  if (!DOCUMENT_EDITABLE_STATUSES.includes(campaign.status)) {
    return { response: NextResponse.json({ error: documentsLockedMessage(campaign.status) }, { status: 409 }) };
  }
  const doc = await prisma.campaignDocument.findFirst({
    where: { id: params.docId, campaignId: campaign.id },
    include: { documentTemplate: true },
  });
  if (!doc) return { response: NextResponse.json({ error: 'Document not attached to this campaign.' }, { status: 404 }) };
  return { session, campaign, doc };
}

const patchSchema = z.object({ action: z.literal('refresh') });

/** Updates the campaign's snapshot to the library document's current version. */
export const PATCH = withErrorHandling(async (req, ctx: Params) => {
  const loaded = await loadForChange(req, ctx);
  if ('response' in loaded) return loaded.response!;
  const { session, campaign, doc } = loaded;
  patchSchema.parse(await req.json());

  if (doc.documentTemplate.archived) {
    return NextResponse.json({ error: 'The library document is archived. Restore it before updating.' }, { status: 400 });
  }
  const changes = snapshotDrift(doc, doc.documentTemplate);
  await prisma.campaignDocument.update({ where: { id: doc.id }, data: snapshotFromTemplate(doc.documentTemplate) });
  await audit(session, 'CAMPAIGN_DOCUMENT_REFRESH', {
    targetType: 'Campaign',
    targetId: campaign.id,
    metadata: { campaignDocumentId: doc.id, changes },
  });
  return NextResponse.json({ ok: true, changes });
});

export const DELETE = withErrorHandling(async (req, ctx: Params) => {
  const loaded = await loadForChange(req, ctx);
  if ('response' in loaded) return loaded.response!;
  const { session, campaign, doc } = loaded;
  await prisma.campaignDocument.delete({ where: { id: doc.id } });
  await audit(session, 'CAMPAIGN_DOCUMENT_REMOVE', {
    targetType: 'Campaign',
    targetId: campaign.id,
    metadata: { campaignDocumentId: doc.id, name: doc.name },
  });
  return NextResponse.json({ ok: true });
});
