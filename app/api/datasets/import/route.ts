import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite, resolveWorkspaceId } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { linkContactsForDataset } from '@/lib/records/contactLink';
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
  requireCanWrite(session);
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

  // Build every row's payload up front so the transaction below does a
  // fixed, small number of round trips regardless of dataset size.
  const rowPayloads = rows.map((row) => {
    const data: Record<string, unknown> = {};
    for (const [header, key] of Object.entries(body.headerToKey)) {
      data[key] = row[header];
    }
    return data;
  });

  const result = await prisma.$transaction(
    async (tx) => {
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
      const newColumns = body.columns.filter((col) => !existingKeys.has(col.key));
      if (newColumns.length > 0) {
        // One statement instead of one per column.
        await tx.datasetColumn.createMany({
          data: newColumns.map((col, i) => ({
            datasetId: dataset.id,
            key: col.key,
            label: col.label,
            type: col.type,
            order: existingColumns.length + i + 1,
          })),
        });
      }

      // createMany is a single INSERT. The previous per-row create() meant
      // one network round trip per record, so a 263-row import against a
      // hosted database spent 20s+ inside an interactive transaction and
      // died on Prisma's 5s default with P2028 ("Transaction not found").
      const { count } = await tx.record.createMany({
        data: rowPayloads.map((data) => ({
          datasetId: dataset.id,
          data: data as Prisma.InputJsonValue,
        })),
      });

      return { dataset, created: count };
    },
    // Generous ceiling for genuinely large imports; the work inside is now
    // a handful of statements, so this should never be approached.
    { timeout: 30_000, maxWait: 10_000 }
  );

  // Contact linking runs outside the transaction: it is best-effort and
  // must not be able to roll back a successful import.
  let contactsLinked = 0;
  if (body.emailColumn) {
    contactsLinked = await linkContactsForDataset({
      organizationId: session.organizationId,
      workspaceId,
      datasetId: result.dataset.id,
    });
  }

  await audit(session, 'DATASET_IMPORT', {
    targetType: 'Dataset',
    targetId: result.dataset.id,
    metadata: { recordsImported: result.created, contactsLinked, duplicateStrategy: body.duplicateStrategy },
  });

  return NextResponse.json({ dataset: result.dataset, recordsImported: result.created, contactsLinked }, { status: 201 });
});
