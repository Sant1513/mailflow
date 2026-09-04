import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { Role } from '@prisma/client';

async function loadDatasetForSession(session: Awaited<ReturnType<typeof requireSession>>, id: string) {
  const dataset = await prisma.dataset.findUnique({ where: { id } });
  if (!dataset) return null;
  if (dataset.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError('Not your workspace');
  }
  return dataset;
}

export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const dataset = await loadDatasetForSession(session, params.id);
  if (!dataset) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const columns = await prisma.datasetColumn.findMany({
    where: { datasetId: dataset.id },
    orderBy: { order: 'asc' },
  });

  const url = new URL(_req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') ?? '100')));

  const [records, total] = await Promise.all([
    prisma.record.findMany({
      where: { datasetId: dataset.id },
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.record.count({ where: { datasetId: dataset.id } }),
  ]);

  if (dataset.workspaceId !== session.workspaceId) {
    await audit(session, 'ADMIN_VIEW', { targetType: 'Dataset', targetId: dataset.id });
  }

  return NextResponse.json({ dataset, columns, records, total, page, pageSize });
});

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
});

export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const dataset = await loadDatasetForSession(session, params.id);
  if (!dataset) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = patchSchema.parse(await req.json());
  const updated = await prisma.dataset.update({ where: { id: dataset.id }, data: body });
  await audit(session, 'DATASET_UPDATE', { targetType: 'Dataset', targetId: dataset.id, metadata: body });

  return NextResponse.json({ dataset: updated });
});

export const DELETE = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const dataset = await loadDatasetForSession(session, params.id);
  if (!dataset) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.dataset.delete({ where: { id: dataset.id } });
  await audit(session, 'DATASET_DELETE', { targetType: 'Dataset', targetId: dataset.id });

  return NextResponse.json({ ok: true });
});
