import { prisma } from '@/lib/db/client';
import { ForbiddenError } from '@/lib/auth/session';
import type { AppSession } from '@/lib/auth/session';
import { Role } from '@prisma/client';

/**
 * Resolves the workspaceId a request is allowed to operate on.
 * - Normal users: only their own workspace (session.workspaceId).
 * - SUPER_ADMIN viewing as (§9): session.workspaceId is already the viewed
 *   workspace, so the default path applies.
 * - SUPER_ADMIN: may pass an explicit `?workspaceId=` to read another
 *   workspace, but every such access is audited by the caller (§9/§128).
 */
export async function resolveWorkspaceId(
  session: AppSession,
  requestedWorkspaceId?: string | null
): Promise<string> {
  if (!requestedWorkspaceId || requestedWorkspaceId === session.workspaceId) {
    if (!session.workspaceId) throw new ForbiddenError('No workspace on session');
    return session.workspaceId;
  }

  if (session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError('Cannot access another workspace');
  }

  const ws = await prisma.workspace.findFirst({
    where: { id: requestedWorkspaceId, organizationId: session.organizationId },
  });
  if (!ws) throw new ForbiddenError('Workspace not found in this organization');
  return ws.id;
}

export function canWrite(role: Role): boolean {
  return role === Role.SUPER_ADMIN || role === Role.ADMIN || role === Role.OPERATOR;
}

/**
 * Gate for every mutation. Accepts the whole session so that "view as"
 * (§9) is read-only: a SUPER_ADMIN inspecting someone else's workspace can
 * look at everything but change nothing — inspection is not impersonation,
 * and nothing they do can be mistaken for the workspace owner's action.
 */
export function requireCanWrite(sessionOrRole: AppSession | Role) {
  const role = typeof sessionOrRole === 'string' ? sessionOrRole : sessionOrRole.role;
  if (!canWrite(role)) throw new ForbiddenError('Viewers cannot make changes');
  if (typeof sessionOrRole !== 'string' && sessionOrRole.viewingAs) {
    throw new ForbiddenError(
      'Read-only while viewing another workspace — exit the view to make changes'
    );
  }
}
