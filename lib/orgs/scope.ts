import { Prisma, Role } from '@prisma/client';
import type { AppSession } from '@/lib/auth/session';

/**
 * Who may see Recruiter Bulk Send emails and recruiters. They are admin tools, so only Admins and Super Admins see them:
 *   Super Admin  every organisation's sends in the company (optionally narrowed to one organisation)
 *   Admin        their own organisation's sends, whoever in it sent them
 * Anyone else sees none. (Sends made before organisations existed were given their creator's organisation when this shipped.)
 */
export function blastScope(session: Pick<AppSession, 'organizationId' | 'role' | 'orgUnitId'>, narrowTo?: { orgUnitId?: string | null; createdById?: string | null }): Prisma.RecruiterBlastWhereInput | null {
  const and: Prisma.RecruiterBlastWhereInput[] = [{ organizationId: session.organizationId }];
  if (session.role === Role.SUPER_ADMIN) {
    if (narrowTo?.orgUnitId) and.push({ orgUnitId: narrowTo.orgUnitId });
  } else if (session.role === Role.ADMIN && session.orgUnitId) {
    and.push({ orgUnitId: session.orgUnitId });
  } else {
    return null;
  }
  if (narrowTo?.createdById) and.push({ createdById: narrowTo.createdById });
  return { AND: and };
}
