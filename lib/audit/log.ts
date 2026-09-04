import { prisma } from '@/lib/db/client';
import type { AppSession } from '@/lib/auth/session';

/**
 * Central audit writer — see spec §95 for the full list of actions that
 * must be audited. Call this from the route handler right after the
 * mutation succeeds (or the admin read happens), never speculatively.
 */
export async function audit(
  session: AppSession | { organizationId: string; userId?: string },
  action: string,
  opts?: { targetType?: string; targetId?: string; metadata?: Record<string, unknown> }
) {
  await prisma.auditLog.create({
    data: {
      organizationId: session.organizationId,
      actorId: 'userId' in session ? session.userId ?? null : null,
      action,
      targetType: opts?.targetType,
      targetId: opts?.targetId,
      metadata: opts?.metadata as any,
    },
  });
}
