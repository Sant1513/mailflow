import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadDatasetForSession } from '@/lib/records/datasetAccess';
import { viewBodySchema } from '@/lib/records/query';

type Params = { params: { id: string; viewId: string } };

export const PATCH = withErrorHandling(async (req, { params }: Params) => {
  const session = await requireSession();
  requireCanWrite(session);
  const dataset = await loadDatasetForSession(session, params.id);
  if (!dataset) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const existing = await prisma.savedView.findFirst({ where: { id: params.viewId, datasetId: dataset.id } });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = viewBodySchema.partial().parse(await req.json());
  const view = await prisma.savedView.update({
    where: { id: existing.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.filter !== undefined ? { filter: body.filter as any } : {}),
      ...(body.sort !== undefined ? { sort: (body.sort ?? undefined) as any } : {}),
      ...(body.groupBy !== undefined ? { groupBy: body.groupBy } : {}),
    },
  });
  await audit(session, 'SAVED_VIEW_UPDATE', { targetType: 'SavedView', targetId: view.id, metadata: { datasetId: dataset.id, fields: Object.keys(body) } });
  return NextResponse.json({ view });
});

export const DELETE = withErrorHandling(async (_req, { params }: Params) => {
  const session = await requireSession();
  requireCanWrite(session);
  const dataset = await loadDatasetForSession(session, params.id);
  if (!dataset) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const existing = await prisma.savedView.findFirst({ where: { id: params.viewId, datasetId: dataset.id } });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.savedView.delete({ where: { id: existing.id } });
  await audit(session, 'SAVED_VIEW_DELETE', { targetType: 'SavedView', targetId: existing.id, metadata: { datasetId: dataset.id, name: existing.name } });
  return NextResponse.json({ ok: true });
});
