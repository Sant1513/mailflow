import { Role } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { ForbiddenError, requireRole, type AppSession } from '@/lib/auth/session';
import { availableFallbackMailboxes, loadOrgScope, ownMailboxIn } from '@/lib/campaigns/fallback';
import { orgOfSend, resolveSendOrg } from '@/lib/orgs/units';

/** Recruiter Bulk Send is for admins (ADMIN, SUPER_ADMIN). */
export async function requireBlastAdmin(): Promise<AppSession> {
  const session = await requireRole([Role.ADMIN, Role.SUPER_ADMIN]);
  if (session.viewingAs) throw new ForbiddenError('Read-only while viewing as another user.');
  if (!session.workspaceId) throw new ForbiddenError('No workspace on your account.');
  return session;
}

/** Reading a send (list, detail, previews): also allowed while a Super Admin views another workspace (read-only). */
export async function requireBlastReader(): Promise<AppSession> {
  const session = await requireRole([Role.ADMIN, Role.SUPER_ADMIN]);
  if (!session.workspaceId) throw new ForbiddenError('No workspace on your account.');
  return session;
}

/** loadBlast's access rules, reading only the status columns (the live progress poll). */
export async function loadBlastStatus(session: AppSession, id: string) {
  const blast = await prisma.recruiterBlast.findUnique({
    where: { id },
    select: { id: true, organizationId: true, workspaceId: true, status: true, scheduledAt: true, startedAt: true, completedAt: true, updatedAt: true, runOn: true, runOnChangedAt: true, note: true },
  });
  if (!blast) return null;
  if (blast.organizationId !== session.organizationId) throw new ForbiddenError('Not your organisation');
  if (blast.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) throw new ForbiddenError('Not your workspace');
  return blast;
}

export async function loadBlast(session: AppSession, id: string) {
  const blast = await prisma.recruiterBlast.findUnique({ where: { id } });
  if (!blast) return null;
  if (blast.organizationId !== session.organizationId) throw new ForbiddenError('Not your organisation');
  if (blast.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) throw new ForbiddenError('Not your workspace');
  return blast;
}

/**
 * Ids of the mailboxes this send may use: the sender's own and the opted-in backups of ONE organisation, the one the send
 * is made as (checked again at start and before every message). `send` is the blast, or an organisation id.
 */
export async function allowedMailboxIds(organizationId: string, userId: string, send: { orgUnitId?: string | null } | string | null): Promise<Set<string>> {
  const orgUnitId = typeof send === 'string' ? send : await orgOfSend({ orgUnitId: send?.orgUnitId, createdById: userId });
  const scope = await loadOrgScope(orgUnitId);
  const own = await ownMailboxIn(userId, scope);
  const others = await availableFallbackMailboxes(organizationId, own?.id, scope);
  return new Set([...(own ? [own.id] : []), ...others.map((m) => m.id)]);
}

/** Mailboxes the admin may send from as this organisation (default: their own): their mailbox if it belongs, plus the organisation's opted-in backups. */
export async function sendableMailboxes(session: AppSession, orgUnitId?: string | null) {
  const unit = await resolveSendOrg(session, orgUnitId);
  const scope = { orgUnitId: unit.id, domains: unit.domains };
  const own = await ownMailboxIn(session.userId, scope);
  const others = await availableFallbackMailboxes(session.organizationId, own?.id, scope);
  const list = [
    ...(own ? [{ id: own.id, emailAddress: own.emailAddress, ownerName: session.name, status: own.status, own: true }] : []),
    ...others.map((m) => ({ id: m.id, emailAddress: m.emailAddress, ownerName: m.ownerName, status: m.status, own: false })),
  ];
  return list;
}
