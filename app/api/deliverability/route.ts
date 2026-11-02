import { NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { deliverabilityReport } from '@/lib/email/deliverability';

// Mail → Deliverability. Super admins see the whole organisation; everyone else their workspace.
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const days = Math.min(90, Math.max(1, Number(new URL(req.url).searchParams.get('days') ?? '30') || 30));
  const workspaceIds =
    session.role === Role.SUPER_ADMIN
      ? (await prisma.workspace.findMany({ where: { organizationId: session.organizationId }, select: { id: true } })).map((w) => w.id)
      : session.workspaceId
        ? [session.workspaceId]
        : [];
  if (!workspaceIds.length) return NextResponse.json({ error: 'No workspace on your account.' }, { status: 400 });
  return NextResponse.json({ scope: session.role === Role.SUPER_ADMIN ? 'organisation' : 'workspace', ...(await deliverabilityReport(workspaceIds, days)) });
});
