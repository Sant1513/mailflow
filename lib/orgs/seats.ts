import { prisma } from '@/lib/db/client';
import { seatStatus, type SeatStatus } from '@/lib/orgs/lifecycle';

/**
 * Seats: the most ACTIVE people an organisation may have (OrgUnit.seatLimit, null = unlimited). Pending sign-ups do not use a seat;
 * a seat is taken when someone is approved or re-enabled, or moved into the organisation (docs/org-lifecycle.md).
 */

/** People using a seat in this organisation. */
export async function activeSeats(orgUnitId: string): Promise<number> {
  return prisma.user.count({ where: { orgUnitId, status: 'ACTIVE' } });
}

export async function seatsOf(orgUnitId: string): Promise<(SeatStatus & { orgName: string }) | null> {
  const org = await prisma.orgUnit.findUnique({ where: { id: orgUnitId }, select: { name: true, seatLimit: true } });
  if (!org) return null;
  return { ...seatStatus(org.seatLimit, await activeSeats(orgUnitId)), orgName: org.name };
}

export class SeatLimitError extends Error {
  status = 409;
  code = 'SEAT_LIMIT';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Is there a free seat for one more ACTIVE person? Returns null when yes, or the message for people when not
 * ("5 of 5 seats used in Neev Labs. Raise the limit or disable someone."). \`excludeUserId\`: the person being approved or moved,
 * who is not counted against themselves (so re-saving an already active person never fails).
 */
export async function seatProblem(orgUnitId: string | null | undefined, excludeUserId?: string): Promise<string | null> {
  if (!orgUnitId) return null;
  const org = await prisma.orgUnit.findUnique({ where: { id: orgUnitId }, select: { name: true, seatLimit: true } });
  if (!org || org.seatLimit === null) return null;
  const used = await prisma.user.count({ where: { orgUnitId, status: 'ACTIVE', ...(excludeUserId ? { id: { not: excludeUserId } } : {}) } });
  if (used < org.seatLimit) return null;
  return `${used} of ${org.seatLimit} seats used in ${org.name}. Raise the limit or disable someone.`;
}

/** Throws SeatLimitError (HTTP 409) when the organisation has no free seat. */
export async function assertSeatAvailable(orgUnitId: string | null | undefined, excludeUserId?: string): Promise<void> {
  const problem = await seatProblem(orgUnitId, excludeUserId);
  if (problem) throw new SeatLimitError(problem);
}
