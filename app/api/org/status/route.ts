import { NextResponse } from 'next/server';
import { Role, UserStatus } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { orgAccessFor, platformContacts } from '@/lib/orgs/status';
import { seatStatus } from '@/lib/orgs/lifecycle';

export const dynamic = 'force-dynamic';

/**
 * The signed-in person's organisation: its access state (active / expiring / expired / disabled), the words to show and who to
 * contact. Answered even while the organisation is locked (the lock screen needs it). Admins also get the seat numbers.
 */
export const GET = withErrorHandling(async () => {
  const session = await requireSession({ allowLocked: true });
  const found = await orgAccessFor(session.orgUnitId);
  const contacts = await platformContacts(session.organizationId);
  if (!found) return NextResponse.json({ org: null, state: 'ACTIVE', level: null, daysLeft: null, validUntil: null, locksAt: null, message: null, contacts });
  const { unit, access, message } = found;
  let seats: { used: number; limit: number | null } | undefined;
  if (session.role === Role.ADMIN || session.role === Role.SUPER_ADMIN) {
    const used = await prisma.user.count({ where: { orgUnitId: unit.id, status: UserStatus.ACTIVE } });
    const s = seatStatus(unit.seatLimit, used);
    seats = { used: s.used, limit: s.limit };
  }
  return NextResponse.json({
    org: { id: unit.id, name: unit.name },
    state: access.state,
    level: access.level,
    daysLeft: access.daysLeft,
    validUntil: access.validUntil,
    locksAt: access.locksAt,
    message,
    ...(seats ? { seats } : {}),
    contacts,
  });
});
