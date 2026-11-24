import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { assignUserToOrg } from '@/lib/orgs/units';
import { seatProblem } from '@/lib/orgs/seats';
import { Role, UserStatus } from '@prisma/client';

const patchSchema = z.object({
  role: z.nativeEnum(Role).optional(),
  status: z.nativeEnum(UserStatus).optional(),
  /** The organisation (team) the person belongs to: chosen when approving, changeable later. */
  orgUnitId: z.string().trim().min(1).max(64).optional(),
  /** Slack member id (U…); empty string clears it. */
  slackUserId: z.string().trim().max(40).regex(/^(U|W)[A-Z0-9]{6,}$|^$/, 'Slack member ids look like U04ABCDEF').optional(),
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
  if (target.id === session.userId && body.status && body.status !== target.status && body.status !== 'ACTIVE') {
    return NextResponse.json({ error: "You can't disable your own account (you would be locked out)." }, { status: 400 });
  }
  // The organisation always keeps at least one active Super Admin.
  const losesSuperAdmin = target.role === Role.SUPER_ADMIN && target.status === 'ACTIVE' && ((body.role && body.role !== Role.SUPER_ADMIN) || (body.status && body.status !== 'ACTIVE'));
  if (losesSuperAdmin) {
    const others = await prisma.user.count({ where: { organizationId: session.organizationId, role: Role.SUPER_ADMIN, status: 'ACTIVE', id: { not: target.id } } });
    if (!others) return NextResponse.json({ error: 'This is the last active Super Admin. Make someone else a Super Admin first.' }, { status: 400 });
  }

  // Approving needs an organisation: a person without one could not send as anyone.
  if (body.status === 'ACTIVE' && target.status !== 'ACTIVE' && !target.orgUnitId && !body.orgUnitId) {
    return NextResponse.json({ error: 'Choose an organisation for this person before approving them.' }, { status: 400 });
  }
  // Approving or re-enabling someone takes a seat in their organisation (the one chosen now, else the one they have).
  if (body.status === 'ACTIVE' && target.status !== 'ACTIVE') {
    const seatMsg = await seatProblem(body.orgUnitId ?? target.orgUnitId, target.id);
    if (seatMsg) return NextResponse.json({ error: seatMsg, code: 'SEAT_LIMIT' }, { status: 409 });
  }
  if (body.orgUnitId) {
    const placed = await assignUserToOrg(session, target.id, body.orgUnitId);
    if (!placed) return NextResponse.json({ error: 'That organisation does not exist.' }, { status: 400 });
  }
  const { orgUnitId: _org, ...rest } = body;
  const updated = await prisma.user.update({
    where: { id: target.id },
    data: { ...rest, ...(body.slackUserId !== undefined ? { slackUserId: body.slackUserId || null } : {}) },
  });

  // Disabling (or sending back to pending) signs them out everywhere at once. Role changes need
  // no sign-out: the role is re-read from the database on every request.
  if (body.status && body.status !== 'ACTIVE' && target.status === 'ACTIVE') {
    await prisma.session.deleteMany({ where: { userId: target.id } });
  }

  await audit(session, body.role ? 'ROLE_CHANGE' : 'USER_STATUS_CHANGE', {
    targetType: 'User',
    targetId: target.id,
    metadata: { from: { role: target.role, status: target.status }, to: body },
  });

  return NextResponse.json({ user: updated });
});
