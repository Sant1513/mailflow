import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { Role } from '@prisma/client';

export async function loadBatchForSession(session: Awaited<ReturnType<typeof requireSession>>, batchId: string) {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: { campaign: true },
  });
  if (!batch) return null;
  if (batch.campaign.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError('Not your workspace');
  }
  return batch;
}

export const GET = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const batch = await loadBatchForSession(session, params.id);
  if (!batch) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(200, Number(url.searchParams.get('pageSize') ?? '50'));

  const [jobs, counts] = await Promise.all([
    prisma.emailJob.findMany({
      where: { batchId: batch.id },
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        toEmail: true,
        subject: true,
        status: true,
        sendReason: true,
        skipReason: true,
        errorCode: true,
        errorMessage: true,
        retryCount: true,
        sentAt: true,
        gmailMessageId: true,
        gmailThreadId: true,
      },
    }),
    prisma.emailJob.groupBy({ by: ['status'], where: { batchId: batch.id }, _count: true }),
  ]);

  return NextResponse.json({
    batch,
    jobs,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    page,
    pageSize,
  });
});
