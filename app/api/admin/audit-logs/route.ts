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

  // Filters
  const from       = url.searchParams.get('from');
  const to         = url.searchParams.get('to');
  const actorId    = url.searchParams.get('actorId');
  const action     = url.searchParams.get('action');
  const targetType = url.searchParams.get('targetType');
  const workspaceId = url.searchParams.get('workspaceId');

  const where: any = { organizationId: session.organizationId };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      where.createdAt.lte = toDate;
    }
  }
  if (actorId === 'system') where.actorId = null;
  else if (actorId) where.actorId = actorId;
  if (action) where.action = { contains: action, mode: 'insensitive' };
  if (targetType) where.targetType = { contains: targetType, mode: 'insensitive' };
  // Workspace filter: scope to logs whose actor belongs to that workspace
  if (workspaceId) {
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId },
      select: { userId: true },
    });
    const ids = members.map((m) => m.userId);
    where.actorId = { in: ids };
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { actor: { select: { name: true, email: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);

  // Also return distinct action types and users for filter dropdowns
  const [actions, users, workspaces] = await Promise.all([
    prisma.auditLog.findMany({
      where: { organizationId: session.organizationId },
      distinct: ['action'],
      select: { action: true },
      orderBy: { action: 'asc' },
    }),
    prisma.user.findMany({
      where: { organizationId: session.organizationId },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    }),
    prisma.workspace.findMany({
      where: { organizationId: session.organizationId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  return NextResponse.json({
    logs,
    total,
    page,
    pageSize,
    meta: {
      actions: actions.map((a) => a.action),
      users,
      workspaces,
    },
  });
});
