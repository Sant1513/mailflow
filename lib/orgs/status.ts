import { Role, UserStatus } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { accessMessage, accessOf, type OrgAccess } from '@/lib/orgs/lifecycle';

/** The organisation a person belongs to with its access state and the message to show (null when they have no organisation). */
export async function orgAccessFor(orgUnitId: string | null | undefined, now: Date = new Date()) {
  if (!orgUnitId) return null;
  const unit = await prisma.orgUnit.findUnique({ where: { id: orgUnitId }, select: { id: true, name: true, status: true, validUntil: true, graceDays: true, seatLimit: true } });
  if (!unit) return null;
  const access: OrgAccess = accessOf(unit, now);
  return { unit, access, message: accessMessage(access, unit.name) };
}

/** The MailFlow team (active Super Admins) a locked organisation is told to contact. */
export async function platformContacts(organizationId: string): Promise<{ name: string; email: string }[]> {
  const admins = await prisma.user.findMany({ where: { organizationId, role: Role.SUPER_ADMIN, status: UserStatus.ACTIVE }, orderBy: { name: 'asc' }, select: { name: true, email: true } });
  return admins.map((a) => ({ name: a.name, email: a.email }));
}
