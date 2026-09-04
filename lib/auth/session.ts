import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';
import { Role } from '@prisma/client';

export class UnauthorizedError extends Error {
  status = 401;
  constructor(message = 'Not signed in') {
    super(message);
  }
}

export class ForbiddenError extends Error {
  status = 403;
  constructor(message = 'Not permitted') {
    super(message);
  }
}

export interface AppSession {
  userId: string;
  organizationId: string;
  workspaceId: string | null;
  role: Role;
  email: string;
  name: string;
}

/**
 * The ONLY place identity is derived. Every API route / server action must
 * call this (or requireRole) instead of trusting any userId/workspaceId/role
 * sent by the client — see ARCHITECTURE.md §12.
 */
export async function requireSession(): Promise<AppSession> {
  const session = await getServerSession(authOptions);
  const user = session?.user as any;
  if (!session || !user?.id) {
    throw new UnauthorizedError();
  }
  return {
    userId: user.id,
    organizationId: user.organizationId,
    workspaceId: user.workspaceId,
    role: user.role as Role,
    email: user.email,
    name: user.name,
  };
}

export async function requireRole(allowed: Role[]): Promise<AppSession> {
  const session = await requireSession();
  if (!allowed.includes(session.role)) {
    throw new ForbiddenError(`Requires one of: ${allowed.join(', ')}`);
  }
  return session;
}

export function isSuperAdmin(session: AppSession): boolean {
  return session.role === Role.SUPER_ADMIN;
}
