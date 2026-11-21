import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';

/**
 * One suppression list per ORGANISATION for bounces and spam complaints.
 *
 * A bounce (the address doesn't exist, has left, blocks us…) or a spam complaint blocks that address for every
 * workspace in the organisation: no teammate's tool should mail it again. That used to be done by saving a copy in
 * each workspace (about 30 copies of every address, which filled the free database). Now it is saved once, in the
 * workspace where it happened, and every check looks across the organisation's workspaces for those two reasons.
 * Unsubscribes and manual entries stay per workspace: they are a choice about that sender.
 */
export const SHARED_REASONS = ['BOUNCED', 'COMPLAINT'] as const;

const cache = new Map<string, { ids: string[]; at: number }>();
const TTL_MS = 5 * 60_000;

/** The ids of every workspace in this workspace's organisation (itself included). */
export async function orgWorkspaceIds(workspaceId: string): Promise<string[]> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ids;
  let ids = [workspaceId];
  try {
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { organizationId: true } });
    if (ws) {
      const all = await prisma.workspace.findMany({ where: { organizationId: ws.organizationId }, select: { id: true } });
      ids = [...new Set([workspaceId, ...all.map((w) => w.id)])];
    }
  } catch {
    return [workspaceId]; // never cached: the next check asks again
  }
  cache.set(workspaceId, { ids, at: Date.now() });
  return ids;
}

/** Test hook: forget the cached organisations. */
export function resetOrgScopeCache(): void {
  cache.clear();
}

/** The suppression rows that apply to this workspace: its own, plus every bounce / complaint in its organisation. */
export async function visibleToWorkspace(workspaceId: string): Promise<Prisma.EmailSuppressionWhereInput> {
  const ids = await orgWorkspaceIds(workspaceId);
  if (ids.length < 2) return { workspaceId };
  return { OR: [{ workspaceId }, { workspaceId: { in: ids }, reason: { in: [...SHARED_REASONS] } }] };
}

/** The same rule as a SQL condition on "EmailSuppression" (for raw queries). */
export async function visibleSql(workspaceId: string): Promise<Prisma.Sql> {
  const ids = await orgWorkspaceIds(workspaceId);
  if (ids.length < 2) return Prisma.sql`"workspaceId" = ${workspaceId}`;
  return Prisma.sql`("workspaceId" = ${workspaceId} OR ("workspaceId" = ANY(${ids}::text[]) AND "reason" IN ('BOUNCED', 'COMPLAINT')))`;
}
