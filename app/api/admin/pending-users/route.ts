import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { UserStatus } from '@prisma/client';

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

  return NextResponse.json({ users });
});
