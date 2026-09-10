import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { findOrCreateContactForRecord } from '@/lib/records/contactLink';
import { onRecordChanged } from '@/lib/automation/runner';
import { Role } from '@prisma/client';

const createSchema = z.object({
  data: z.record(z.any()).default({}),
});

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);

  const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
  if (!dataset) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (dataset.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError();
  }

  const body = createSchema.parse(await req.json());
  const contactId = await findOrCreateContactForRecord({
    organizationId: dataset.organizationId,
    workspaceId: dataset.workspaceId,
    datasetId: dataset.id,
    data: body.data,
  });

  const record = await prisma.record.create({
    data: { datasetId: dataset.id, data: body.data, contactId },
  });

  await audit(session, 'RECORD_CREATE', { targetType: 'Record', targetId: record.id });

  // §69 RECORD_CREATED trigger. Never fails the write (see the update route).
  let automationResults: unknown[] = [];
  try {
    automationResults = await onRecordChanged({
      recordId: record.id,
      datasetId: dataset.id,
      workspaceId: dataset.workspaceId,
      triggerType: 'RECORD_CREATED',
    });
  } catch (err) {
    console.error('[automation] evaluation failed after record create', err);
  }

  return NextResponse.json({ record, automations: automationResults }, { status: 201 });
});
