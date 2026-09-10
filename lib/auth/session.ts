import { getServerSession } from 'next-auth';
import { cookies } from 'next/headers';
import { authOptions } from '@/lib/auth/options';
import { prisma } from '@/lib/db/client';
import { VIEW_AS_COOKIE, verifyViewAs } from '@/lib/auth/viewAs';
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

/** §9 — present only while a SUPER_ADMIN is inspecting another workspace. */
export interface ViewingAs {
  workspaceId: string;
  workspaceName: string;
  ownerName: string;
  ownerEmail: string;
}

export interface AppSession {
  userId: string;
  organizationId: string;
  /** The workspace every query is scoped to. Overridden while viewing as. */
  workspaceId: string | null;
  /** The caller's own workspace, untouched by "view as". */
  homeWorkspaceId: string | null;
  role: Role;
  email: string;
  name: string;
  /** Set while a SUPER_ADMIN is viewing another user's workspace (§9). */
  viewingAs?: ViewingAs;
}

async function baseSession(): Promise<AppSession | null> {
  const session = await getServerSession(authOptions);
  const user = session?.user as any;
  if (!session || !user?.id) return null;
  return {
    userId: user.id,
    organizationId: user.organizationId,
    workspaceId: user.workspaceId,
    homeWorkspaceId: user.workspaceId,
    role: user.role as Role,
    email: user.email,
    name: user.name,
  };
}

/**
 * Reads the signed view-as cookie. Returns null when absent, invalid,
 * expired, or when called outside a request (e.g. from a worker), so
 * callers can never end up half-scoped.
 */
function readViewAsCookie(): string | null {
  try {
    return verifyViewAs(cookies().get(VIEW_AS_COOKIE)?.value);
  } catch {
    return null;
  }
}

/**
 * Applies §9: a SUPER_ADMIN with a valid view-as cookie has workspaceId
 * swapped to the viewed workspace. The workspace must still belong to the
 * same organization on EVERY request — the cookie is a pointer, not a
 * grant. userId is deliberately left alone: viewing another workspace
 * never means acting as its owner, and never touches their Gmail (§10).
 */
async function applyViewAs(session: AppSession): Promise<AppSession> {
  if (session.role !== Role.SUPER_ADMIN) return session;
  const viewedId = readViewAsCookie();
  if (!viewedId || viewedId === session.homeWorkspaceId) return session;

  const ws = await prisma.workspace.findFirst({
    where: { id: viewedId, organizationId: session.organizationId },
    select: { id: true, name: true, owner: { select: { name: true, email: true } } },
  });
  if (!ws) return session;

  return {
    ...session,
    workspaceId: ws.id,
    viewingAs: {
      workspaceId: ws.id,
      workspaceName: ws.name,
      ownerName: ws.owner.name,
      ownerEmail: ws.owner.email,
    },
  };
}

/**
 * The ONLY place identity is derived. Every API route / server action must
 * call this (or requireRole) instead of trusting any userId/workspaceId/role
 * sent by the client — see ARCHITECTURE.md §12.
 */
export async function requireSession(): Promise<AppSession> {
  const session = await baseSession();
  if (!session) throw new UnauthorizedError();
  return applyViewAs(session);
}

/** Same as requireSession but resolves to null instead of throwing. */
export async function getOptionalSession(): Promise<AppSession | null> {
  const session = await baseSession();
  return session ? applyViewAs(session) : null;
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
