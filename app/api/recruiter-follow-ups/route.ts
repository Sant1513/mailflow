import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { allowedMailboxIds, loadBlast, requireBlastAdmin, requireBlastReader } from '@/lib/recruiterSend/access';
import { orgOfSend } from '@/lib/orgs/units';
import { applyAudience, FOLLOW_UP_SEGMENTS, followUpSubject, LEGACY_AUDIENCES, NOT_REPLIED_SEGMENTS, parseSegments } from '@/lib/recruiterSend/followUp';

/**
 * Recruiter Follow-up tab. GET: the sends that finished (any round) that can be followed up, and
 * the follow-ups made so far. POST: a new follow-up draft from a finished send, with its audience.
 * The draft is an ordinary RecruiterBlast (parentBlastId set), edited, checked and sent with the
 * same pages and routes as a Recruiter Bulk Send.
 */
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const session = await requireBlastReader();
  const scope = { organizationId: session.organizationId, ...(session.role === 'SUPER_ADMIN' ? {} : { workspaceId: session.workspaceId! }) };
  const [finished, followUps] = await Promise.all([
    prisma.recruiterBlast.findMany({
      where: { ...scope, status: 'COMPLETED' },
      orderBy: [{ completedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      take: 100,
      select: { id: true, name: true, subject: true, mode: true, round: true, rootBlastId: true, parentBlastId: true, startedAt: true, completedAt: true },
    }),
    prisma.recruiterBlast.findMany({
      where: { ...scope, parentBlastId: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 100,
      select: { id: true, name: true, subject: true, mode: true, status: true, round: true, rootBlastId: true, parentBlastId: true, followUpAudience: true, createdAt: true, startedAt: true, completedAt: true, scheduledAt: true, note: true },
    }),
  ]);
  const ids = [...new Set([...finished.map((b) => b.id), ...followUps.map((b) => b.id)])];
  const parentIds = [...new Set(followUps.map((f) => f.parentBlastId!))];
  const [counts, replied, opened, children, parents] = ids.length
    ? await Promise.all([
        prisma.recruiterBlastRecipient.groupBy({ by: ['blastId'], where: { blastId: { in: ids }, status: 'SENT' }, _count: { _all: true } }),
        prisma.recruiterBlastRecipient.groupBy({ by: ['blastId'], where: { blastId: { in: ids }, repliedAt: { not: null } }, _count: { _all: true } }),
        prisma.recruiterBlastRecipient.groupBy({ by: ['blastId'], where: { blastId: { in: ids }, openCount: { gt: 0 } }, _count: { _all: true } }),
        prisma.recruiterBlast.groupBy({ by: ['parentBlastId'], where: { parentBlastId: { in: ids } }, _count: { _all: true } }),
        prisma.recruiterBlast.findMany({ where: { id: { in: parentIds } }, select: { id: true, name: true } }),
      ])
    : [[], [], [], [], []];
  const n = (rows: { blastId: string; _count: { _all: number } }[], id: string) => rows.find((r) => r.blastId === id)?._count._all ?? 0;
  const stats = (id: string) => ({ sent: n(counts, id), replied: n(replied, id), opened: n(opened, id) });
  return NextResponse.json({
    sources: finished
      .map((b) => ({ ...b, ...stats(b.id), followUps: children.find((c) => c.parentBlastId === b.id)?._count._all ?? 0 }))
      // Nothing was sent: nobody to follow up.
      .filter((b) => b.sent > 0),
    followUps: followUps.map((f) => ({ ...f, ...stats(f.id), parentName: parents.find((p) => p.id === f.parentBlastId)?.name ?? null })),
  });
});

const createSchema = z.object({
  parentId: z.string().min(1),
  /** The segments to start with (default: everyone who has not replied). */
  segments: z.array(z.enum(FOLLOW_UP_SEGMENTS)).min(1).optional(),
  /** The first version's single choice, still accepted. */
  audience: z.enum(LEGACY_AUDIENCES).optional(),
});

export const POST = withErrorHandling(async (req) => {
  const session = await requireBlastAdmin();
  const { parentId, segments: wanted, audience: legacy } = createSchema.parse(await req.json());
  const segments = wanted ?? (legacy ? parseSegments(legacy) : NOT_REPLIED_SEGMENTS);
  const parent = await loadBlast(session, parentId);
  if (!parent) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (parent.status !== 'COMPLETED') return NextResponse.json({ error: 'Only a send that has finished can be followed up.' }, { status: 409 });
  const rootId = parent.rootBlastId ?? parent.id;

  // One follow-up at a time per send: an unfinished draft is reopened (not duplicated), and a follow-up
  // that is sending, scheduled or paused blocks another (they would email the same people twice).
  const open = await prisma.recruiterBlast.findFirst({
    where: { parentBlastId: parent.id, status: { in: ['DRAFT', 'SCHEDULED', 'SENDING', 'PAUSED'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, createdById: true },
  });
  if (open?.status === 'DRAFT') return NextResponse.json({ id: open.id, reused: true });
  if (open) return NextResponse.json({ error: 'A follow-up to this send is already ' + (open.status === 'SENDING' ? 'sending' : open.status.toLowerCase()) + '. Wait for it to finish (or cancel it) before making another.', existingId: open.id }, { status: 409 });

  // The mailboxes that carried the chain, so the follow-up can reply from them (kept to ones this admin may still use).
  const allowed = await allowedMailboxIds(session.organizationId, session.userId, parent);
  const used = await prisma.recruiterBlastGroup.findMany({
    where: { status: 'SENT', accountId: { not: null }, blast: { OR: [{ id: rootId }, { rootBlastId: rootId }] } },
    distinct: ['accountId'],
    select: { accountId: true },
  });
  const accountIds = used.map((g) => g.accountId!).filter((id) => allowed.has(id)).slice(0, 50);
  const limits = (parent.accountLimits && typeof parent.accountLimits === 'object' ? parent.accountLimits : {}) as Record<string, number>;

  const draft = await prisma.recruiterBlast.create({
    data: {
      organizationId: session.organizationId,
      orgUnitId: await orgOfSend(parent),
      workspaceId: session.workspaceId!,
      createdById: session.userId,
      name: `Follow-up ${parent.round} · ${parent.name}`.slice(0, 200),
      mode: parent.mode,
      toAddress: parent.toAddress,
      subject: followUpSubject(parent.subject),
      // The new email starts empty; the earlier one is shown beside it on the page.
      html: '',
      plainText: '',
      body: '',
      format: parent.format,
      includeSignature: parent.includeSignature,
      fromName: parent.fromName,
      replyTo: parent.replyTo,
      ccAddresses: parent.ccAddresses,
      columns: parent.columns,
      emailColumn: parent.emailColumn,
      accountIds,
      accountLimits: Object.fromEntries(Object.entries(limits).filter(([id]) => accountIds.includes(id))),
      groupSize: parent.groupSize,
      sendOrder: parent.sendOrder,
      gapSeconds: parent.gapSeconds,
      parentBlastId: parent.id,
      rootBlastId: rootId,
      round: parent.round + 1,
      followUpAudience: segments.join(','),
      onMailboxDown: 'WAIT',
    },
  });
  const count = await applyAudience(draft.id, rootId, segments);
  await audit(session, 'RECRUITER_FOLLOW_UP_CREATE', { targetType: 'RecruiterBlast', targetId: draft.id, metadata: { parentBlastId: parent.id, rootBlastId: rootId, round: draft.round, segments, recipients: count } });
  return NextResponse.json({ id: draft.id, recipients: count, round: draft.round });
});
