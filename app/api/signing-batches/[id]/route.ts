import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';

/** GET /api/signing-batches/[id] — fetch batch detail with all requests. */
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  if (!session.workspaceId) {
    return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  }

  const batch = await prisma.signingBatch.findFirst({
    where: { id: params.id, workspaceId: session.workspaceId },
    include: {
      template: { select: { title: true } },
      requests: {
        select: {
          id: true,
          recipientName: true,
          recipientEmail: true,
          fieldValues: true,
          status: true,
          sentAt: true,
          signedAt: true,
          token: true,
          groupId: true,
          signerOrder: true,
          signerRole: true,
        },
        orderBy: [{ signerOrder: 'asc' }, { createdAt: 'asc' }],
      },
      groups: {
        select: {
          id: true,
          signingOrder: true,
          totalSigners: true,
          signedCount: true,
          status: true,
        },
      },
    },
  });

  if (!batch) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const pending = batch.requests.filter(
    (r) => !['SIGNED', 'VOIDED', 'EXPIRED'].includes(r.status),
  ).length;

  return NextResponse.json({
    batch,
    summary: {
      total: batch.totalCount,
      sent: batch.sentCount,
      signed: batch.signedCount,
      pending,
    },
  });
});

const patchSchema = z.object({ action: z.literal('void') });

/** PATCH /api/signing-batches/[id] — void all pending requests in a batch. */
export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  if (!session.workspaceId) {
    return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  }

  patchSchema.parse(await req.json());

  const batch = await prisma.signingBatch.findFirst({
    where: { id: params.id, workspaceId: session.workspaceId },
  });
  if (!batch) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  await prisma.signingRequest.updateMany({
    where: { batchId: batch.id, status: { in: ['DRAFT', 'SENT', 'VIEWED'] } },
    data: { status: 'VOIDED' },
  });

  await prisma.signingGroup.updateMany({
    where: { batchId: batch.id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    data: { status: 'VOIDED' },
  });

  await audit(session, 'SIGNING_BATCH_VOIDED', {
    targetType: 'SigningBatch',
    targetId: batch.id,
  });

  return NextResponse.json({ voided: true });
});
