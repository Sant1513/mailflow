import { prisma } from '@/lib/db/client';
import { ForbiddenError, type AppSession } from '@/lib/auth/session';
import { Role } from '@prisma/client';

/**
 * Loads an automation with its versions and recent runs, enforcing
 * workspace ownership in one place (§94).
 *
 * Lives in lib/ rather than beside the route because Next.js route files
 * may only export HTTP handlers — exporting a helper from one makes the
 * production build fail (something `tsc --noEmit` alone does not catch).
 */
export async function loadAutomationForSession(session: AppSession, automationId: string) {
  const automation = await prisma.automation.findUnique({
    where: { id: automationId },
    include: {
      versions: { orderBy: { version: 'desc' } },
      runs: { orderBy: { createdAt: 'desc' }, take: 50 },
    },
  });
  if (!automation) return null;
  if (automation.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError('Not your workspace');
  }
  return automation;
}
