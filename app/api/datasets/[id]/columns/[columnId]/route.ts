import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { linkContactsForDataset } from '@/lib/records/contactLink';
import { ColumnType, Role } from '@prisma/client';

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
  // Retyping matters: import type-inference can guess wrong (an email
  // column named "Status" lands as TEXT), and without this there is no way
  // to correct it — the dataset stays permanently unsendable because
  // contact linking and recipient resolution both require an EMAIL column.
  type: z.nativeEnum(ColumnType).optional(),
  hidden: z.boolean().optional(),
  order: z.number().int().optional(),
  width: z.number().int().positive().optional(),
  options: z.array(z.string()).optional(),
});

export const PATCH = withErrorHandling(
  async (req, { params }: { params: { id: string; columnId: string } }) => {
    const session = await requireSession();
    requireCanWrite(session);
    const column = await loadColumn(session, params.id, params.columnId);
    if (!column) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (column.isSystem) throw new ForbiddenError('System columns cannot be modified');

    const body = patchSchema.parse(await req.json());

    // Only one EMAIL column can be the recipient source, and
    // findOrCreateContactForRecord picks the lowest-ordered one. Promoting
    // a second column to EMAIL would silently change who gets mailed, so
    // refuse rather than guess.
    if (body.type === ColumnType.EMAIL && column.type !== ColumnType.EMAIL) {
      const existingEmailColumn = await prisma.datasetColumn.findFirst({
        where: { datasetId: params.id, type: ColumnType.EMAIL, id: { not: column.id } },
      });
      if (existingEmailColumn) {
        return NextResponse.json(
          {
            error: `"${existingEmailColumn.label}" is already the email column for this dataset. Change it to another type first.`,
          },
          { status: 409 }
        );
      }
    }

    const updated = await prisma.datasetColumn.update({ where: { id: column.id }, data: body });

    // Retyping to EMAIL is the recovery path for a mis-detected column, so
    // backfill the contacts that could not be created while it was TEXT.
    let contactsLinked = 0;
    if (body.type === ColumnType.EMAIL && column.type !== ColumnType.EMAIL) {
      const dataset = await prisma.dataset.findUniqueOrThrow({ where: { id: params.id } });
      contactsLinked = await linkContactsForDataset({
        organizationId: dataset.organizationId,
        workspaceId: dataset.workspaceId,
        datasetId: dataset.id,
      });
    }

    await audit(session, 'DATASET_COLUMN_UPDATE', {
      targetType: 'DatasetColumn',
      targetId: column.id,
      metadata: { ...body, previousType: column.type, contactsLinked },
    });

    return NextResponse.json({ column: updated, contactsLinked });
  }
);

export const DELETE = withErrorHandling(
  async (_req, { params }: { params: { id: string; columnId: string } }) => {
    const session = await requireSession();
    requireCanWrite(session);
    const column = await loadColumn(session, params.id, params.columnId);
    if (!column) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (column.isSystem) throw new ForbiddenError('System columns cannot be deleted');

    await prisma.datasetColumn.delete({ where: { id: column.id } });
    await audit(session, 'DATASET_COLUMN_DELETE', { targetType: 'DatasetColumn', targetId: column.id });

    return NextResponse.json({ ok: true });
  }
);
