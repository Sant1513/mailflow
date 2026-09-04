import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { findOrCreateContactForRecord } from '@/lib/records/contactLink';
import { Role } from '@prisma/client';

async function loadRecord(session: Awaited<ReturnType<typeof requireSession>>, id: string) {
  const record = await prisma.record.findUnique({ where: { id }, include: { dataset: true } });
  if (!record) return null;
  if (record.dataset.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError();
  }
  return record;
}

const patchSchema = z.object({
  data: z.record(z.any()).optional(),
});

export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const record = await loadRecord(session, params.id);
  if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = patchSchema.parse(await req.json());
  if (!body.data) return NextResponse.json({ record });

  const oldData = (record.data ?? {}) as Record<string, unknown>;
  const newData = { ...oldData, ...body.data };

  const changedFields = Object.keys(body.data).filter(
    (key) => JSON.stringify(oldData[key]) !== JSON.stringify(body.data![key])
  );

  const contactId = await findOrCreateContactForRecord({
    organizationId: record.dataset.organizationId,
    workspaceId: record.dataset.workspaceId,
    datasetId: record.datasetId,
    data: newData,
  });

  const updated = await prisma.$transaction(async (tx) => {
    const rec = await tx.record.update({
      where: { id: record.id },
      data: { data: newData, contactId: contactId ?? record.contactId },
    });
    for (const field of changedFields) {
      await tx.recordChangeHistory.create({
        data: {
          recordId: record.id,
          actorId: session.userId,
          field,
          oldValue: oldData[field] as any,
          newValue: body.data![field] as any,
          reason: 'Manual edit',
        },
      });
    }
    return rec;
  });

  await audit(session, 'RECORD_UPDATE', { targetType: 'Record', targetId: record.id, metadata: { changedFields } });

  return NextResponse.json({ record: updated });
});

export const DELETE = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const record = await loadRecord(session, params.id);
  if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.record.delete({ where: { id: record.id } });
  await audit(session, 'RECORD_DELETE', { targetType: 'Record', targetId: record.id });

  return NextResponse.json({ ok: true });
});
