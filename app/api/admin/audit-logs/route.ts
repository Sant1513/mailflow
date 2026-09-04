import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { Role } from '@prisma/client';

export const GET = withErrorHandling(async (req) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = 50;

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where: { organizationId: session.organizationId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { actor: { select: { name: true, email: true } } },
    }),
    prisma.auditLog.count({ where: { organizationId: session.organizationId } }),
  ]);

  return NextResponse.json({ logs, total, page, pageSize });
});
