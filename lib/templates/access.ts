import { prisma } from '@/lib/db/client';
import { ForbiddenError, type AppSession } from '@/lib/auth/session';
import { Role } from '@prisma/client';

/**
 * Loads a template and enforces workspace ownership in one place, so no
 * route can accidentally serve another workspace's template (§94).
 * SUPER_ADMIN may read across workspaces; the caller audits that access.
 */
export async function loadTemplateForSession(session: AppSession, templateId: string) {
  const template = await prisma.template.findUnique({
    where: { id: templateId },
    include: { versions: { orderBy: { version: 'desc' } } },
  });
  if (!template) return null;
  if (template.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError('Not your workspace');
  }
  return template;
}

export function latestVersionOf<T extends { version: number }>(versions: T[]): T | null {
  return versions.length ? versions.reduce((a, b) => (a.version >= b.version ? a : b)) : null;
}
