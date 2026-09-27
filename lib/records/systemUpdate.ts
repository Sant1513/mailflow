import { ColumnType, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { findOrCreateContactForRecord } from '@/lib/records/contactLink';
import { onRecordChanged } from '@/lib/automation/runner';

/**
 * Record updates made by MailFlow itself (e-signature status, Google Sheets
 * sync) rather than by a person in the grid. Same guarantees as a manual
 * edit: only changed keys are written, each change is in RecordChangeHistory
 * with a reason, and RECORD_UPDATED automations evaluate afterwards (never
 * failing the write).
 */

export interface ColumnSpec {
  key: string;
  label: string;
  type: ColumnType;
}

/** Adds any of `columns` the dataset doesn't have yet, after the existing ones. */
export async function ensureColumns(datasetId: string, columns: ColumnSpec[]): Promise<void> {
  const existing = await prisma.datasetColumn.findMany({ where: { datasetId }, select: { key: true, order: true } });
  const have = new Set(existing.map((c) => c.key));
  const missing = columns.filter((c) => !have.has(c.key));
  if (!missing.length) return;
  const maxOrder = existing.reduce((m, c) => Math.max(m, c.order), 0);
  await prisma.datasetColumn.createMany({
    data: missing.map((c, i) => ({ datasetId, key: c.key, label: c.label, type: c.type, order: maxOrder + i + 1 })),
    skipDuplicates: true,
  });
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function updateRecordFields(opts: {
  recordId: string;
  fields: Record<string, unknown>;
  reason: string;
  actorId?: string | null;
  /** Default true. Sheets sync passes false for bulk pulls and runs automations itself. */
  runAutomations?: boolean;
}): Promise<{ changed: string[] }> {
  const record = await prisma.record.findUnique({
    where: { id: opts.recordId },
    select: { id: true, data: true, contactId: true, datasetId: true, dataset: { select: { organizationId: true, workspaceId: true } } },
  });
  if (!record) return { changed: [] };

  const oldData = (record.data ?? {}) as Record<string, unknown>;
  const changed = Object.keys(opts.fields).filter((k) => !same(oldData[k], opts.fields[k]));
  if (!changed.length) return { changed };

  const newData = { ...oldData };
  for (const k of changed) newData[k] = opts.fields[k] ?? null;

  const contactId = await findOrCreateContactForRecord({
    organizationId: record.dataset.organizationId,
    workspaceId: record.dataset.workspaceId,
    datasetId: record.datasetId,
    data: newData,
  }).catch(() => null);

  await prisma.$transaction([
    prisma.record.update({
      where: { id: record.id },
      data: { data: newData as Prisma.InputJsonValue, contactId: contactId ?? record.contactId },
    }),
    prisma.recordChangeHistory.createMany({
      data: changed.map((field) => ({
        recordId: record.id,
        actorId: opts.actorId ?? null,
        field,
        oldValue: (oldData[field] ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        newValue: (opts.fields[field] ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        reason: opts.reason,
      })),
    }),
  ]);

  if (opts.runAutomations !== false) {
    try {
      await onRecordChanged({ recordId: record.id, datasetId: record.datasetId, workspaceId: record.dataset.workspaceId, triggerType: 'RECORD_UPDATED' });
    } catch (err) {
      console.error('[automation] evaluation failed after system record update', err);
    }
  }
  return { changed };
}
