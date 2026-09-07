import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { ColumnType, Role } from '@prisma/client';

const createSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Column key must be alphanumeric/underscore, starting with a letter'),
  label: z.string().min(1).max(200),
  type: z.nativeEnum(ColumnType).default(ColumnType.TEXT),
  options: z.array(z.string()).optional(),
});

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);

  const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
  if (!dataset) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (dataset.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError();
  }

  const body = createSchema.parse(await req.json());
  const maxOrder = await prisma.datasetColumn.aggregate({
    where: { datasetId: dataset.id },
    _max: { order: true },
  });

  const column = await prisma.datasetColumn.create({
    data: {
      datasetId: dataset.id,
      key: body.key,
      label: body.label,
      type: body.type,
      options: body.options,
      order: (maxOrder._max.order ?? 0) + 1,
    },
  });

  await audit(session, 'DATASET_COLUMN_CREATE', { targetType: 'Dataset', targetId: dataset.id, metadata: { column: body.key } });

  return NextResponse.json({ column }, { status: 201 });
});

const reorderSchema = z.object({
  /** Every column id of the dataset, in the desired display order. */
  order: z.array(z.string().min(1)).min(1).max(500),
});

/** §12 reorder columns: the client sends the full id order; ids not in the dataset are rejected. */
export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);

  const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
  if (!dataset) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (dataset.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError();
  }

  const body = reorderSchema.parse(await req.json());
  const existing = await prisma.datasetColumn.findMany({ where: { datasetId: dataset.id }, select: { id: true } });
  const known = new Set(existing.map((c) => c.id));
  const unknown = body.order.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return NextResponse.json({ error: `Unknown column id(s): ${unknown.join(', ')}` }, { status: 400 });
  }

  await prisma.$transaction(
    body.order.map((id, index) => prisma.datasetColumn.update({ where: { id }, data: { order: index } }))
  );
  await audit(session, 'DATASET_COLUMN_REORDER', { targetType: 'Dataset', targetId: dataset.id, metadata: { count: body.order.length } });

  const columns = await prisma.datasetColumn.findMany({ where: { datasetId: dataset.id }, orderBy: { order: 'asc' } });
  return NextResponse.json({ columns });
});
