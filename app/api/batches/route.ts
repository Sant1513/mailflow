import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId } from '@/lib/permissions/workspace';
import { BatchStatus, Prisma } from '@prisma/client';

/**
 * §40 batches across the workspace: queue progress per batch, newest first.
 * `?status=active|done|all`, `?q=` (batch label / campaign name), paging.
 */
const ACTIVE: BatchStatus[] = [BatchStatus.PREPARING, BatchStatus.QUEUED, BatchStatus.RUNNING, BatchStatus.PAUSED];
const DONE: BatchStatus[] = [BatchStatus.COMPLETED, BatchStatus.PARTIALLY_FAILED, BatchStatus.FAILED, BatchStatus.CANCELLED];

export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));
  const status = url.searchParams.get('status') ?? 'all';
  const q = url.searchParams.get('q')?.trim();
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? '25')));

  const where: Prisma.BatchWhereInput = {
    campaign: { workspaceId },
    ...(status === 'active' ? { status: { in: ACTIVE } } : status === 'done' ? { status: { in: DONE } } : {}),
    ...(q ? { OR: [{ label: { contains: q, mode: 'insensitive' } }, { campaign: { name: { contains: q, mode: 'insensitive' } } }] } : {}),
  };

  const [batches, total, active] = await Promise.all([
    prisma.batch.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        label: true,
        status: true,
        total: true,
        validCount: true,
        sentCount: true,
        failedCount: true,
        skippedCount: true,
        createdAt: true,
        updatedAt: true,
        campaign: { select: { id: true, name: true, status: true, createdBy: { select: { name: true } } } },
        _count: { select: { jobs: true } },
      },
    }),
    prisma.batch.count({ where }),
    prisma.batch.count({ where: { campaign: { workspaceId }, status: { in: ACTIVE } } }),
  ]);

  // Queued/sending counts per batch on this page, so progress is live rather than the cached counters alone.
  const pending = batches.length
    ? await prisma.emailJob.groupBy({
        by: ['batchId'],
        where: { batchId: { in: batches.map((b) => b.id) }, status: { in: ['QUEUED', 'SENDING'] } },
        _count: { _all: true },
      })
    : [];
  const pendingBy = new Map(pending.map((p) => [p.batchId, p._count._all]));

  return NextResponse.json({
    batches: batches.map((b) => ({ ...b, pendingCount: pendingBy.get(b.id) ?? 0 })),
    total,
    activeCount: active,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  });
});
