import { prisma } from '@/lib/db/client';
import type { AppSession } from '@/lib/auth/session';
import { Role } from '@prisma/client';

/**
 * §36 who may review a campaign. SUPER_ADMIN: every workspace in the
 * organisation. ADMIN: their own workspace plus every workspace where they
 * hold an ADMIN membership (WorkspaceMember). Everyone else: nothing.
 *
 * Returns `null` for "no restriction" (SUPER_ADMIN) so callers can build a
 * Prisma `where` without listing every workspace.
 */
export async function reviewableWorkspaceIds(session: AppSession): Promise<string[] | null> {
  if (session.role === Role.SUPER_ADMIN) return null;
  if (session.role !== Role.ADMIN) return [];
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: session.userId, role: Role.ADMIN, workspace: { organizationId: session.organizationId } },
    select: { workspaceId: true },
  });
  const ids = new Set(memberships.map((m) => m.workspaceId));
  if (session.homeWorkspaceId) ids.add(session.homeWorkspaceId);
  return [...ids];
}

/** Prisma `where` fragment scoping campaigns to what the session may review. */
export async function reviewScope(session: AppSession): Promise<{ organizationId: string } | { workspaceId: { in: string[] } }> {
  const ids = await reviewableWorkspaceIds(session);
  return ids === null ? { organizationId: session.organizationId } : { workspaceId: { in: ids } };
}

export async function canReviewWorkspace(session: AppSession, workspaceId: string): Promise<boolean> {
  const ids = await reviewableWorkspaceIds(session);
  return ids === null || ids.includes(workspaceId);
}
