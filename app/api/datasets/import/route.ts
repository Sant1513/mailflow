import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite, resolveWorkspaceId } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { findOrCreateContactForRecord } from '@/lib/records/contactLink';
import { ColumnType, Prisma } from '@prisma/client';

const columnSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  label: z.string().min(1),
  type: z.nativeEnum(ColumnType),
});

const commitSchema = z.object({
  workspaceId: z.string().optional(),
  datasetId: z.string().optional(), // import into an existing dataset
  datasetName: z.string().min(1).optional(), // or create a new one
  columns: z.array(columnSchema).min(1),
  headerToKey: z.record(z.string()), // original header -> column key
  rows: z.array(z.record(z.any())),
  emailColumn: z.string().optional(),
  duplicateStrategy: z.enum(['KEEP_FIRST', 'KEEP_LATEST', 'IMPORT_ALL']).default('KEEP_FIRST'),
});

/**
 * §15/§140: real, DB-backed commit of a previously previewed import.
 * IMPORT NEVER SENDS EMAILS — this route only ever creates Dataset /
 * DatasetColumn / Record / Contact rows.
 */
export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const body = commitSchema.parse(await req.json());
  const workspaceId = await resolveWorkspaceId(session, body.workspaceId);

  if (!body.datasetId && !body.datasetName) {
    return NextResponse.json({ error: 'datasetId or datasetName is required' }, { status: 400 });
  }

  // Deduplicate rows by the chosen email column before writing, per the
  // user's chosen strategy (§15).
  let rows = body.rows;
  if (body.emailColumn && body.duplicateStrategy !== 'IMPORT_ALL') {
    const byEmail = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const email = String(row[body.emailColumn] ?? '').trim().toLowerCase();
      if (!email) continue;
      if (!byEmail.has(email) || body.duplicateStrategy === 'KEEP_LATEST') {
        byEmail.set(email, row);
      }
    }
    rows = Array.from(byEmail.values());
  }

  const result = await prisma.$transaction(async (tx) => {
    const dataset = body.datasetId
      ? await tx.dataset.findUniqueOrThrow({ where: { id: body.datasetId } })
      : await tx.dataset.create({
          data: {
            organizationId: session.organizationId,
            workspaceId,
            ownerId: session.userId,
            name: body.datasetName!,
          },
        });

    const existingColumns = await tx.datasetColumn.findMany({ where: { datasetId: dataset.id } });
    const existingKeys = new Set(existingColumns.map((c) => c.key));
    let order = existingColumns.length;
    for (const col of body.columns) {
      if (!existingKeys.has(col.key)) {
        order += 1;
        await tx.datasetColumn.create({
          data: { datasetId: dataset.id, key: col.key, label: col.label, type: col.type, order },
        });
      }
    }

    let created = 0;
    for (const row of rows) {
      const data: Record<string, unknown> = {};
      for (const [header, key] of Object.entries(body.headerToKey)) {
        data[key] = row[header];
      }
      await tx.record.create({ data: { datasetId: dataset.id, data: data as Prisma.InputJsonValue } });
      created += 1;
    }

    return { dataset, created };
  });

  // Contact linking runs after the transaction (best-effort, non-blocking
  // for the import itself).
  if (body.emailColumn) {
    const records = await prisma.record.findMany({
      where: { datasetId: result.dataset.id },
      orderBy: { createdAt: 'desc' },
      take: result.created,
    });
    for (const record of records) {
      const contactId = await findOrCreateContactForRecord({
        organizationId: session.organizationId,
        workspaceId,
        datasetId: result.dataset.id,
        data: record.data as Record<string, unknown>,
      });
      if (contactId) {
        await prisma.record.update({ where: { id: record.id }, data: { contactId } });
      }
    }
  }

  await audit(session, 'DATASET_IMPORT', {
    targetType: 'Dataset',
    targetId: result.dataset.id,
    metadata: { recordsImported: result.created, duplicateStrategy: body.duplicateStrategy },
  });

  return NextResponse.json({ dataset: result.dataset, recordsImported: result.created }, { status: 201 });
});
