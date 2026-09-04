import { prisma } from '@/lib/db/client';
import { ColumnType } from '@prisma/client';

/**
 * Resolves (and conservatively creates, never merges) the Contact for a
 * record's email value — §18/§19: identity matching is email-based and
 * ambiguity is never silently resolved by merging.
 */
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
