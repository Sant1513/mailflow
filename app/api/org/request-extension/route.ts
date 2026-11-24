import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Role, UserStatus } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';

export const dynamic = 'force-dynamic';

/** One request per organisation every 12 hours: the Super Admins are told once, not on every click. */
export const REQUEST_COOLDOWN_MS = 12 * 3_600_000;

const bodySchema = z.object({ message: z.string().trim().max(500).optional() });

/**
 * "Request renewal / extension": tells every active Super Admin (an in-app notification) that this organisation wants more time.
 * Allowed while the organisation is locked: it is the one thing the lock screen offers.
 */
export const POST = withErrorHandling(async (req: Request) => {
  const session = await requireSession({ allowLocked: true });
  if (!session.orgUnitId) return NextResponse.json({ error: 'You are not in an organisation.' }, { status: 400 });
  const { message } = bodySchema.parse(await req.json().catch(() => ({})));

  const since = new Date(Date.now() - REQUEST_COOLDOWN_MS);
  const recent = await prisma.auditLog.findFirst({
    where: { organizationId: session.organizationId, action: 'ORG_EXTENSION_REQUEST', targetType: 'OrgUnit', targetId: session.orgUnitId, createdAt: { gt: since } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (recent) {
    const hours = Math.max(1, Math.ceil((recent.createdAt.getTime() + REQUEST_COOLDOWN_MS - Date.now()) / 3_600_000));
    return NextResponse.json({ error: `A renewal request was already sent for your organisation. The MailFlow team has been told; you can ask again in about ${hours} hour${hours === 1 ? '' : 's'}.`, alreadySent: true }, { status: 429 });
  }

  const unit = await prisma.orgUnit.findUnique({ where: { id: session.orgUnitId }, select: { name: true } });
  const admins = await prisma.user.findMany({
    where: { organizationId: session.organizationId, role: Role.SUPER_ADMIN, status: UserStatus.ACTIVE },
    select: { id: true, ownedWorkspaces: { select: { id: true }, take: 1 } },
  });
  const rows = admins
    .filter((a) => a.ownedWorkspaces[0])
    .map((a) => ({
      userId: a.id,
      workspaceId: a.ownedWorkspaces[0]!.id,
      type: 'ORG_RENEWAL_REQUEST',
      title: `${unit?.name ?? 'An organisation'} asked to renew`,
      body: `${session.name} (${session.email}) asked for the organisation's access to be extended.${message ? ` Message: “${message}”` : ''}`,
      link: '/admin/organisations',
    }));
  if (rows.length) await prisma.notification.createMany({ data: rows });
  await audit(session, 'ORG_EXTENSION_REQUEST', { targetType: 'OrgUnit', targetId: session.orgUnitId, metadata: { by: session.email, message: message ?? null, notified: rows.length } });
  return NextResponse.json({ ok: true, notified: rows.length });
});
