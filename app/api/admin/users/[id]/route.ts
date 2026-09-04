import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { Role, UserStatus } from '@prisma/client';

const patchSchema = z.object({
  role: z.nativeEnum(Role).optional(),
  status: z.nativeEnum(UserStatus).optional(),
});

// §128: role/status changes are SUPER_ADMIN-only and always audited.
export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  const body = patchSchema.parse(await req.json());

  const target = await prisma.user.findUnique({ where: { id: params.id } });
  if (!target || target.organizationId !== session.organizationId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (target.id === session.userId && body.role && body.role !== Role.SUPER_ADMIN) {
    return NextResponse.json({ error: 'Cannot demote yourself' }, { status: 400 });
  }

  const updated = await prisma.user.update({ where: { id: target.id }, data: body });

  await audit(session, body.role ? 'ROLE_CHANGE' : 'USER_STATUS_CHANGE', {
    targetType: 'User',
    targetId: target.id,
    metadata: { from: { role: target.role, status: target.status }, to: body },
  });

  return NextResponse.json({ user: updated });
});
