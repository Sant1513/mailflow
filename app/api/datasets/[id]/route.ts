import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { Role } from '@prisma/client';
import { loadDatasetForSession as loadDatasetShared } from '@/lib/records/datasetAccess';
import { applyView, parseViewQuery, type ViewQuery } from '@/lib/records/query';

async function loadDatasetForSession(session: Awaited<ReturnType<typeof requireSession>>, id: string) {
  const dataset = await prisma.dataset.findUnique({ where: { id } });
  if (!dataset) return null;
  if (dataset.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError('Not your workspace');
  }
  return dataset;
}

/**
 * §12 grid read. Filter / search / sort / group / paginate run server-side
 * (lib/records/query.ts); the browser only receives one page (§135).
 * `?viewId=` applies a saved view; any explicit filter/sort/groupBy in the
 * query overrides that view's setting for this request.
 */
const RECORD_CAP = 5000;

export const GET = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const dataset = await loadDatasetShared(session, params.id, { auditCrossWorkspace: true });
  if (!dataset) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const url = new URL(req.url);
  const requested = parseViewQuery(url.searchParams);
  const viewId = url.searchParams.get('viewId');
  const view = viewId ? await prisma.savedView.findFirst({ where: { id: viewId, datasetId: dataset.id } }) : null;

  const query: ViewQuery = {
    ...requested,
    filter: requested.filter ?? ((view?.filter as any) || undefined),
    sort: requested.sort ?? ((view?.sort as any) || undefined),
    groupBy: requested.groupBy ?? view?.groupBy ?? undefined,
  };

  const [columns, savedViews, all, total] = await Promise.all([
    prisma.datasetColumn.findMany({ where: { datasetId: dataset.id }, orderBy: { order: 'asc' } }),
    prisma.savedView.findMany({ where: { datasetId: dataset.id }, orderBy: { createdAt: 'asc' } }),
    prisma.record.findMany({ where: { datasetId: dataset.id }, orderBy: { createdAt: 'asc' }, take: RECORD_CAP }),
    prisma.record.count({ where: { datasetId: dataset.id } }),
  ]);

  const result = applyView(all as any, query);

  return NextResponse.json({
    dataset,
    columns,
    savedViews,
    records: result.records,
    total,
    matched: result.matched,
    page: result.page,
    pageSize: result.pageSize,
    pageCount: result.pageCount,
    groups: result.groups,
    groupOf: result.groupOf,
    query,
    viewId: view?.id ?? null,
    truncated: total > RECORD_CAP,
  });
});

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
});

export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const dataset = await loadDatasetForSession(session, params.id);
  if (!dataset) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = patchSchema.parse(await req.json());
  const updated = await prisma.dataset.update({ where: { id: dataset.id }, data: body });
  await audit(session, 'DATASET_UPDATE', { targetType: 'Dataset', targetId: dataset.id, metadata: body });

  return NextResponse.json({ dataset: updated });
});

export const DELETE = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const dataset = await loadDatasetForSession(session, params.id);
  if (!dataset) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.dataset.delete({ where: { id: dataset.id } });
  await audit(session, 'DATASET_DELETE', { targetType: 'Dataset', targetId: dataset.id });

  return NextResponse.json({ ok: true });
});
