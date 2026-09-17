import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';

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
          status: true,
          sentAt: true,
          signedAt: true,
          token: true,
        },
        orderBy: { createdAt: 'asc' },
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
