import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { Role } from '@prisma/client';

export const GET = withErrorHandling(async () => {
  const session = await requireRole([Role.SUPER_ADMIN]);

  const users = await prisma.user.findMany({
    where: { organizationId: session.organizationId },
    orderBy: { createdAt: 'asc' },
    include: {
      ownedWorkspaces: {
        include: { _count: { select: { contacts: true, campaigns: true } } },
      },
    },
  });

  await audit(session, 'ADMIN_VIEW', { targetType: 'UserList' });

  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      status: u.status,
      lastLoginAt: u.lastLoginAt,
      workspace: u.ownedWorkspaces[0]
        ? {
            id: u.ownedWorkspaces[0].id,
            name: u.ownedWorkspaces[0].name,
            contacts: u.ownedWorkspaces[0]._count.contacts,
            campaigns: u.ownedWorkspaces[0]._count.campaigns,
          }
        : null,
    })),
  });
});
