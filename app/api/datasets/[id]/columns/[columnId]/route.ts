import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { Role } from '@prisma/client';

async function loadColumn(session: Awaited<ReturnType<typeof requireSession>>, datasetId: string, columnId: string) {
  const column = await prisma.datasetColumn.findFirst({ where: { id: columnId, datasetId } });
  if (!column) return null;
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });
  if (!dataset) return null;
  if (dataset.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError();
  }
  return column;
}

const patchSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  hidden: z.boolean().optional(),
  order: z.number().int().optional(),
  width: z.number().int().positive().optional(),
  options: z.array(z.string()).optional(),
});

export const PATCH = withErrorHandling(
  async (req, { params }: { params: { id: string; columnId: string } }) => {
    const session = await requireSession();
    requireCanWrite(session.role);
    const column = await loadColumn(session, params.id, params.columnId);
    if (!column) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (column.isSystem) throw new ForbiddenError('System columns cannot be modified');

    const body = patchSchema.parse(await req.json());
    const updated = await prisma.datasetColumn.update({ where: { id: column.id }, data: body });
    await audit(session, 'DATASET_COLUMN_UPDATE', { targetType: 'DatasetColumn', targetId: column.id, metadata: body });

    return NextResponse.json({ column: updated });
  }
);

export const DELETE = withErrorHandling(
  async (_req, { params }: { params: { id: string; columnId: string } }) => {
    const session = await requireSession();
    requireCanWrite(session.role);
    const column = await loadColumn(session, params.id, params.columnId);
    if (!column) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (column.isSystem) throw new ForbiddenError('System columns cannot be deleted');

    await prisma.datasetColumn.delete({ where: { id: column.id } });
    await audit(session, 'DATASET_COLUMN_DELETE', { targetType: 'DatasetColumn', targetId: column.id });

    return NextResponse.json({ ok: true });
  }
);
