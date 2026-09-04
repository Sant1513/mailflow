import { prisma } from '@/lib/db/client';
import { ForbiddenError, type AppSession } from '@/lib/auth/session';
import { Role } from '@prisma/client';

/**
 * Loads a batch with its campaign, enforcing workspace ownership (§94).
 * In lib/ rather than beside the route: Next.js route files may only export
 * HTTP handlers.
 */
export async function loadBatchForSession(session: AppSession, batchId: string) {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: { campaign: true },
  });
  if (!batch) return null;
  if (batch.campaign.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError('Not your workspace');
  }
  return batch;
}
