import { prisma } from '@/lib/db/client';
import { ColumnType } from '@prisma/client';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Links every record in a dataset to a Contact, in bulk.
 *
 * Used after an import and after a column is retyped to EMAIL — retyping is
 * the recovery path when type inference guessed wrong, and without a
 * backfill those records would stay unlinked and therefore unsendable.
 *
 * Returns the number of records newly linked. Safe to re-run: records that
 * already point at a contact are skipped.
 */
export async function linkContactsForDataset(opts: {
  organizationId: string;
  workspaceId: string;
  datasetId: string;
}): Promise<number> {
  const emailColumn = await prisma.datasetColumn.findFirst({
    where: { datasetId: opts.datasetId, type: ColumnType.EMAIL },
    orderBy: { order: 'asc' },
  });
  if (!emailColumn) return 0;

  const records = await prisma.record.findMany({
    where: { datasetId: opts.datasetId, contactId: null },
    select: { id: true, data: true },
  });
  if (records.length === 0) return 0;

  // Resolve the distinct addresses first, so N records sharing an address
  // cost one upsert rather than N.
  const emailByRecord = new Map<string, string>();
  for (const record of records) {
    const raw = (record.data as Record<string, unknown>)[emailColumn.key];
    const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (email && EMAIL_RE.test(email)) emailByRecord.set(record.id, email);
  }

  // Bulk, in a fixed number of round trips (a 1,000-row list used to cost
  // 1,000+ queries): create the missing contacts in one insert, read every
  // contact back in one query, then link all records in one UPDATE.
  const emails = [...new Set(emailByRecord.values())];
  const contactIdByEmail = new Map<string, string>();
  for (let i = 0; i < emails.length; i += 5000) {
    const chunk = emails.slice(i, i + 5000);
    await prisma.contact.createMany({
      data: chunk.map((primaryEmail) => ({ organizationId: opts.organizationId, workspaceId: opts.workspaceId, primaryEmail })),
      skipDuplicates: true,
    });
    const found = await prisma.contact.findMany({
      where: { workspaceId: opts.workspaceId, primaryEmail: { in: chunk } },
      select: { id: true, primaryEmail: true },
    });
    for (const c of found) contactIdByEmail.set(c.primaryEmail, c.id);
  }

  const pairs = [...emailByRecord].map(([recordId, email]) => [recordId, contactIdByEmail.get(email)] as const).filter((p): p is readonly [string, string] => !!p[1]);
  let linked = 0;
  for (let i = 0; i < pairs.length; i += 5000) {
    const chunk = pairs.slice(i, i + 5000);
    const recordIds = chunk.map((p) => p[0]);
    const contactIds = chunk.map((p) => p[1]);
    linked += await prisma.$executeRaw`
      UPDATE "Record" AS r SET "contactId" = v.cid
      FROM unnest(${recordIds}::text[], ${contactIds}::text[]) AS v(rid, cid)
      WHERE r."id" = v.rid AND r."contactId" IS NULL`;
  }

  return linked;
}

export async function findOrCreateContactForRecord(opts: {
  organizationId: string;
  workspaceId: string;
  datasetId: string;
  data: Record<string, unknown>;
}): Promise<string | null> {
  const emailColumn = await prisma.datasetColumn.findFirst({
    where: { datasetId: opts.datasetId, type: ColumnType.EMAIL },
    orderBy: { order: 'asc' },
  });
  if (!emailColumn) return null;

  const rawEmail = opts.data[emailColumn.key];
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;

  const nameColumn = await prisma.datasetColumn.findFirst({
    where: { datasetId: opts.datasetId, type: { in: [ColumnType.TEXT] }, key: { contains: 'name' } },
  });
  const name = nameColumn ? String(opts.data[nameColumn.key] ?? '') : undefined;

  const contact = await prisma.contact.upsert({
    where: { workspaceId_primaryEmail: { workspaceId: opts.workspaceId, primaryEmail: email } },
    update: name ? { name } : {},
    create: {
      organizationId: opts.organizationId,
      workspaceId: opts.workspaceId,
      primaryEmail: email,
      name,
    },
  });

  return contact.id;
}
