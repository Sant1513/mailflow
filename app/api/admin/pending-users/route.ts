import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { UserStatus } from '@prisma/client';
import { listOrgUnits, suggestOrgFor } from '@/lib/orgs/units';

/** List pending user registrations (super admin only). */
export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  if (session.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Super admin only' }, { status: 403 });
  }

  const users = await prisma.user.findMany({
    where: { organizationId: session.organizationId, status: UserStatus.PENDING },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, email: true, createdAt: true, image: true },
  });

  // The organisations to choose from, and the one a person's domain points at (a suggestion, never forced).
  const orgUnits = await listOrgUnits(session.organizationId);
  return NextResponse.json({ users: users.map((u) => ({ ...u, suggestedOrgUnitId: suggestOrgFor(u.email, orgUnits) })), orgUnits });
});
