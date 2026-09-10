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

  const contactIdByEmail = new Map<string, string>();
  for (const email of new Set(emailByRecord.values())) {
    const contact = await prisma.contact.upsert({
      where: { workspaceId_primaryEmail: { workspaceId: opts.workspaceId, primaryEmail: email } },
      update: {},
      create: {
        organizationId: opts.organizationId,
        workspaceId: opts.workspaceId,
        primaryEmail: email,
      },
    });
    contactIdByEmail.set(email, contact.id);
  }

  // Group records by contact so this is one UPDATE per contact, not per row.
  const recordIdsByContact = new Map<string, string[]>();
  for (const [recordId, email] of emailByRecord) {
    const contactId = contactIdByEmail.get(email)!;
    const list = recordIdsByContact.get(contactId) ?? [];
    list.push(recordId);
    recordIdsByContact.set(contactId, list);
  }

  let linked = 0;
  for (const [contactId, recordIds] of recordIdsByContact) {
    const { count } = await prisma.record.updateMany({
      where: { id: { in: recordIds } },
      data: { contactId },
    });
    linked += count;
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
