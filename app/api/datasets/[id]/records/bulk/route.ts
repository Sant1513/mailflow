import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadDatasetForSession } from '@/lib/records/datasetAccess';
import { findOrCreateContactForRecord } from '@/lib/records/contactLink';
import { onRecordChanged } from '@/lib/automation/runner';

/**
 * §12 bulk select → bulk update / delete. Identical semantics to editing
 * rows one by one: every changed field gets a RecordChangeHistory row,
 * contacts are re-linked, RECORD_UPDATED automations evaluate per record
 * after the write, and the whole thing is audited once with the counts.
 * Capped at 1000 ids per call so a mis-click can't rewrite a whole dataset
 * in one request.
 */
const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('update'),
    recordIds: z.array(z.string().min(1)).min(1).max(1000),
    data: z.record(z.any()).refine((d) => Object.keys(d).length > 0, 'data must set at least one field'),
  }),
  z.object({
    action: z.literal('delete'),
    recordIds: z.array(z.string().min(1)).min(1).max(1000),
  }),
]);

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const dataset = await loadDatasetForSession(session, params.id);
  if (!dataset) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = bodySchema.parse(await req.json());
  // Only ids that belong to THIS dataset — anything else is silently ignored
  // rather than reaching into another dataset by guessing ids.
  const records = await prisma.record.findMany({ where: { id: { in: body.recordIds }, datasetId: dataset.id } });
  const ignored = body.recordIds.length - records.length;

  if (body.action === 'delete') {
    const deleted = await prisma.record.deleteMany({ where: { id: { in: records.map((r) => r.id) } } });
    await audit(session, 'RECORD_BULK_DELETE', { targetType: 'Dataset', targetId: dataset.id, metadata: { deleted: deleted.count, ignored } });
    return NextResponse.json({ deleted: deleted.count, ignored });
  }

  let updated = 0;
  let unchanged = 0;
  const changedIds: string[] = [];

  for (const record of records) {
    const oldData = (record.data ?? {}) as Record<string, unknown>;
    const changedFields = Object.keys(body.data).filter((k) => JSON.stringify(oldData[k]) !== JSON.stringify(body.data[k]));
    if (changedFields.length === 0) {
      unchanged++;
      continue;
    }
    const newData = { ...oldData, ...body.data };
    const contactId = await findOrCreateContactForRecord({
      organizationId: dataset.organizationId,
      workspaceId: dataset.workspaceId,
      datasetId: dataset.id,
      data: newData,
    });
    await prisma.$transaction(async (tx) => {
      await tx.record.update({ where: { id: record.id }, data: { data: newData, contactId: contactId ?? record.contactId } });
      await tx.recordChangeHistory.createMany({
        data: changedFields.map((field) => ({
          recordId: record.id,
          actorId: session.userId,
          field,
          oldValue: oldData[field] as any,
          newValue: body.data[field] as any,
          reason: 'Bulk edit',
        })),
      });
    });
    updated++;
    changedIds.push(record.id);
  }

  await audit(session, 'RECORD_BULK_UPDATE', {
    targetType: 'Dataset',
    targetId: dataset.id,
    metadata: { fields: Object.keys(body.data), updated, unchanged, ignored },
  });

  // §69: bulk edits are still record updates. Evaluated after the writes,
  // never failing them; results are reported so the UI can say what fired.
  let automations = 0;
  for (const recordId of changedIds) {
    try {
      const results = await onRecordChanged({ recordId, datasetId: dataset.id, workspaceId: dataset.workspaceId, triggerType: 'RECORD_UPDATED' });
      automations += Array.isArray(results) ? results.length : 0;
    } catch (err) {
      console.error('[automation] evaluation failed after bulk update', err);
    }
  }

  return NextResponse.json({ updated, unchanged, ignored, automationsEvaluated: automations });
});
