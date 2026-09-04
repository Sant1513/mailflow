import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { loadAutomationForSession } from '../route';

/** §72 automation run log — every evaluation, including the no-ops. */
export const GET = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const automation = await loadAutomationForSession(session, params.id);
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(200, Number(url.searchParams.get('pageSize') ?? '50'));
  const result = url.searchParams.get('result');

  const where = { automationId: automation.id, ...(result ? { result } : {}) };

  const [runs, total, summary] = await Promise.all([
    prisma.automationRun.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { automationVersion: { select: { version: true } } },
    }),
    prisma.automationRun.count({ where }),
    prisma.automationRun.groupBy({ by: ['result'], where: { automationId: automation.id }, _count: true }),
  ]);

  return NextResponse.json({
    runs,
    total,
    page,
    pageSize,
    summary: Object.fromEntries(summary.map((s) => [s.result, s._count])),
  });
});
