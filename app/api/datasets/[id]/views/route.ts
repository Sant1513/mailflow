import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadDatasetForSession } from '@/lib/records/datasetAccess';
import { viewBodySchema } from '@/lib/records/query';

export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const dataset = await loadDatasetForSession(session, params.id);
  if (!dataset) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const views = await prisma.savedView.findMany({ where: { datasetId: dataset.id }, orderBy: { createdAt: 'asc' } });
  return NextResponse.json({ views });
});

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const dataset = await loadDatasetForSession(session, params.id);
  if (!dataset) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = viewBodySchema.parse(await req.json());
  const view = await prisma.savedView.create({
    data: { datasetId: dataset.id, name: body.name, filter: body.filter as any, sort: (body.sort ?? undefined) as any, groupBy: body.groupBy ?? null },
  });
  await audit(session, 'SAVED_VIEW_CREATE', { targetType: 'SavedView', targetId: view.id, metadata: { datasetId: dataset.id, name: body.name } });
  return NextResponse.json({ view }, { status: 201 });
});
