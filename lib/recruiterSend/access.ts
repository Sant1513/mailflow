import { Role } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { ForbiddenError, requireRole, type AppSession } from '@/lib/auth/session';
import { availableFallbackMailboxes, ownMailbox } from '@/lib/campaigns/fallback';

/** Recruiter Bulk Send is for admins (ADMIN, SUPER_ADMIN). */
export async function requireBlastAdmin(): Promise<AppSession> {
  const session = await requireRole([Role.ADMIN, Role.SUPER_ADMIN]);
  if (session.viewingAs) throw new ForbiddenError('Read-only while viewing as another user.');
  if (!session.workspaceId) throw new ForbiddenError('No workspace on your account.');
  return session;
}

export async function loadBlast(session: AppSession, id: string) {
  const blast = await prisma.recruiterBlast.findUnique({ where: { id } });
  if (!blast) return null;
  if (blast.organizationId !== session.organizationId) throw new ForbiddenError('Not your organisation');
  if (blast.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) throw new ForbiddenError('Not your workspace');
  return blast;
}

/** Mailboxes the admin may send from: their own, plus teammates' opted-in backup mailboxes. */
export async function sendableMailboxes(session: AppSession) {
  const own = await ownMailbox(session.userId);
  const others = await availableFallbackMailboxes(session.organizationId, own?.id);
  const list = [
    ...(own ? [{ id: own.id, emailAddress: own.emailAddress, ownerName: session.name, status: own.status, own: true }] : []),
    ...others.map((m) => ({ id: m.id, emailAddress: m.emailAddress, ownerName: m.ownerName, status: m.status, own: false })),
  ];
  return list;
}
