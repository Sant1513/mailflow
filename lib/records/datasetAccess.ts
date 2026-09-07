import { prisma } from '@/lib/db/client';
import { ForbiddenError, type AppSession } from '@/lib/auth/session';
import { audit } from '@/lib/audit/log';
import { Role } from '@prisma/client';

/**
 * One place that answers "may this session touch this dataset?". Normal
 * users: only their own workspace. SUPER_ADMIN: any dataset in the org, but
 * cross-workspace reads are audited (§9). Returns null when the dataset
 * does not exist so routes can 404 rather than leak existence via 403.
 */
export async function loadDatasetForSession(session: AppSession, id: string, opts: { auditCrossWorkspace?: boolean } = {}) {
  const dataset = await prisma.dataset.findUnique({ where: { id } });
  if (!dataset) return null;
  if (dataset.workspaceId !== session.workspaceId) {
    if (session.role !== Role.SUPER_ADMIN || dataset.organizationId !== session.organizationId) {
      throw new ForbiddenError('Not your workspace');
    }
    if (opts.auditCrossWorkspace) {
      await audit(session, 'ADMIN_VIEW', { targetType: 'Dataset', targetId: dataset.id });
    }
  }
  return dataset;
}
