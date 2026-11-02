import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';

/**
 * Settings → Inbox sharing. Each person decides who may see the conversations in their
 * MailFlow inbox (nobody, everyone in the organization, or chosen people) and whether they may
 * also reply from their mailbox. Nothing is shared until the owner turns it on; the rules are
 * applied in lib/conversations/access.ts.
 */
export const dynamic = 'force-dynamic';

const LEVEL = z.enum(['VIEW', 'REPLY']);
const putSchema = z.object({
  everyone: z.enum(['NONE', 'VIEW', 'REPLY']),
  people: z.array(z.object({ userId: z.string().min(1), level: LEVEL })).max(200),
});

export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  const [given, received, members] = await Promise.all([
    prisma.inboxShare.findMany({
      where: { ownerId: session.userId },
      select: { granteeId: true, level: true, grantee: { select: { id: true, name: true, email: true } } },
    }),
    prisma.inboxShare.findMany({
      where: { organizationId: session.organizationId, ownerId: { not: session.userId }, OR: [{ granteeId: session.userId }, { granteeId: null }] },
      select: { level: true, granteeId: true, owner: { select: { id: true, name: true, email: true } } },
    }),
    prisma.user.findMany({
      where: { organizationId: session.organizationId, status: 'ACTIVE', id: { not: session.userId } },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  // An owner may have shared with everyone AND with me directly: show the higher level once.
  const byOwner = new Map<string, { id: string; name: string | null; email: string; level: string }>();
  for (const r of received) {
    const prev = byOwner.get(r.owner.id);
    if (!prev || (prev.level === 'VIEW' && r.level === 'REPLY')) byOwner.set(r.owner.id, { ...r.owner, level: r.level });
  }

  return NextResponse.json({
    everyone: given.find((g) => g.granteeId === null)?.level ?? 'NONE',
    people: given.filter((g) => g.grantee).map((g) => ({ userId: g.granteeId, name: g.grantee!.name, email: g.grantee!.email, level: g.level })),
    sharedWithMe: [...byOwner.values()],
    members,
  });
});

export const PUT = withErrorHandling(async (req) => {
  const session = await requireSession();
  const body = putSchema.parse(await req.json());

  const valid = new Set(
    (
      await prisma.user.findMany({
        where: { organizationId: session.organizationId, id: { in: body.people.map((p) => p.userId) }, NOT: { id: session.userId } },
        select: { id: true },
      })
    ).map((u) => u.id),
  );
  const people = body.people.filter((p) => valid.has(p.userId));

  await prisma.$transaction([
    prisma.inboxShare.deleteMany({ where: { ownerId: session.userId } }),
    ...(body.everyone !== 'NONE'
      ? [prisma.inboxShare.create({ data: { organizationId: session.organizationId, ownerId: session.userId, granteeId: null, level: body.everyone } })]
      : []),
    ...(people.length
      ? [prisma.inboxShare.createMany({ data: people.map((p) => ({ organizationId: session.organizationId, ownerId: session.userId, granteeId: p.userId, level: p.level })) })]
      : []),
  ]);

  await audit(session, 'INBOX_SHARING_UPDATE', { targetType: 'User', targetId: session.userId, metadata: { everyone: body.everyone, people } });
  return NextResponse.json({ ok: true, everyone: body.everyone, people: people.length });
});
