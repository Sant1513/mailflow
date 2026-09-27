import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { loadDatasetForSession } from '@/lib/records/datasetAccess';
import { buildContactWhere } from '@/app/api/segments/_filterContacts';
import {
  CONTACT_EMAIL_KEY,
  CONTACT_NAME_KEY,
  cellText,
  type SigningSource,
  type SourceColumn,
  type SourceRow,
} from '@/lib/signing/fromData';

const MAX_ROWS = 200;

const bodySchema = z.union([
  z.object({ datasetId: z.string().min(1), recordIds: z.array(z.string().min(1)).min(1).max(1000) }),
  z.object({ segmentId: z.string().min(1) }),
]);

function rowData(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((data ?? {}) as Record<string, unknown>)) out[k] = cellText(v);
  return out;
}

/**
 * POST /api/signing-batches/source — the rows behind "Send for signature"
 * from Data (selected records) or a segment (its contacts, each with its
 * newest data row). Values come back as display strings; the bulk page maps
 * columns to the template and sends `source` per row so signing status is
 * written back to it.
 */
export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  if (!session.workspaceId) return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  const body = bodySchema.parse(await req.json());

  if ('datasetId' in body) {
    const dataset = await loadDatasetForSession(session, body.datasetId);
    // Documents are sent from this workspace; its rows must be too.
    if (!dataset || dataset.workspaceId !== session.workspaceId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const [columns, records] = await Promise.all([
      prisma.datasetColumn.findMany({ where: { datasetId: dataset.id }, orderBy: { order: 'asc' }, select: { key: true, label: true } }),
      prisma.record.findMany({
        where: { id: { in: body.recordIds }, datasetId: dataset.id },
        orderBy: { createdAt: 'asc' },
        take: MAX_ROWS + 1,
        select: { id: true, data: true },
      }),
    ]);
    const source: SigningSource & { truncated: boolean } = {
      label: dataset.name,
      columns,
      rows: records.slice(0, MAX_ROWS).map((r) => ({ recordId: r.id, datasetId: dataset.id, data: rowData(r.data) })),
      truncated: records.length > MAX_ROWS,
    };
    return NextResponse.json(source);
  }

  const segment = await prisma.contactSegment.findUnique({ where: { id: body.segmentId } });
  if (!segment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (segment.workspaceId !== session.workspaceId) throw new ForbiddenError();

  const contacts = await prisma.contact.findMany({
    where: { workspaceId: segment.workspaceId, ...buildContactWhere(segment.filters as Record<string, unknown>) },
    orderBy: { updatedAt: 'desc' },
    take: MAX_ROWS + 1,
    select: {
      id: true,
      name: true,
      primaryEmail: true,
      records: {
        where: { dataset: { workspaceId: segment.workspaceId } },
        orderBy: { updatedAt: 'desc' },
        take: 1,
        select: { id: true, datasetId: true, data: true },
      },
    },
  });

  const datasetIds = [...new Set(contacts.flatMap((c) => c.records.map((r) => r.datasetId)))];
  const datasetColumns = datasetIds.length
    ? await prisma.datasetColumn.findMany({
        where: { datasetId: { in: datasetIds } },
        orderBy: [{ datasetId: 'asc' }, { order: 'asc' }],
        select: { key: true, label: true },
      })
    : [];
  // Rows can come from different datasets: offer the union of their columns.
  const seen = new Set<string>();
  const columns: SourceColumn[] = [
    { key: CONTACT_NAME_KEY, label: 'Contact name' },
    { key: CONTACT_EMAIL_KEY, label: 'Contact email' },
  ];
  for (const c of datasetColumns) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    columns.push(c);
  }

  const rows: SourceRow[] = contacts.slice(0, MAX_ROWS).map((c) => {
    const rec = c.records[0];
    return {
      recordId: rec?.id ?? null,
      datasetId: rec?.datasetId ?? null,
      data: { ...(rec ? rowData(rec.data) : {}), [CONTACT_NAME_KEY]: c.name ?? '', [CONTACT_EMAIL_KEY]: c.primaryEmail },
    };
  });

  return NextResponse.json({ label: segment.name, columns, rows, truncated: contacts.length > MAX_ROWS });
});
