import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import {
  VIEW_AS_COOKIE,
  VIEW_AS_MAX_AGE_SECONDS,
  signViewAs,
  viewAsCookieOptions,
} from '@/lib/auth/viewAs';

const enterSchema = z.object({ workspaceId: z.string().min(1).max(64) });

/** §9 — enter "view workspace as". SUPER_ADMIN only; every entry is audited. */
export const POST = withErrorHandling(async (req) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  const { workspaceId } = enterSchema.parse(await req.json());

  const ws = await prisma.workspace.findFirst({
    where: { id: workspaceId, organizationId: session.organizationId },
    select: { id: true, name: true, owner: { select: { id: true, name: true, email: true } } },
  });
  if (!ws) return NextResponse.json({ error: 'Workspace not found in this organization' }, { status: 404 });

  if (ws.id === session.homeWorkspaceId) {
    // Nothing to view "as" — it's already theirs. Clear any stale cookie.
    cookies().set(VIEW_AS_COOKIE, '', { ...viewAsCookieOptions(0) });
    return NextResponse.json({ viewingAs: null });
  }

  await audit(session, 'ADMIN_VIEW_WORKSPACE_ENTER', {
    targetType: 'Workspace',
    targetId: ws.id,
    metadata: { ownerId: ws.owner.id, ownerEmail: ws.owner.email, expiresInSeconds: VIEW_AS_MAX_AGE_SECONDS },
  });

  cookies().set(VIEW_AS_COOKIE, signViewAs(ws.id), viewAsCookieOptions());
  return NextResponse.json({
    viewingAs: { workspaceId: ws.id, workspaceName: ws.name, ownerName: ws.owner.name, ownerEmail: ws.owner.email },
  });
});

/** Current view-as state, for client components that need it. */
export const GET = withErrorHandling(async () => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  return NextResponse.json({ viewingAs: session.viewingAs ?? null });
});

/** §9 "[ Exit View ]" — also audited so the trail shows the full window. */
export const DELETE = withErrorHandling(async () => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  if (session.viewingAs) {
    await audit(session, 'ADMIN_VIEW_WORKSPACE_EXIT', {
      targetType: 'Workspace',
      targetId: session.viewingAs.workspaceId,
    });
  }
  cookies().set(VIEW_AS_COOKIE, '', { ...viewAsCookieOptions(0) });
  return NextResponse.json({ viewingAs: null });
});
