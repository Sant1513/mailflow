import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { loadBlast, requireBlastAdmin, sendableMailboxes } from '@/lib/recruiterSend/access';
import { buildBody, MAX_GROUP_SIZE, MIN_GAP, type BlastMode } from '@/lib/recruiterSend/core';
import { usageLast24h, dailyLimit } from '@/lib/queue/drain';
import { isValidEmail } from '@/lib/quickSend/prepare';
import { readVideo, videoLinkCard, videoSchema } from '@/lib/recruiterSend/video';
import { Prisma } from '@prisma/client';

/** One recruiter send: everything the page shows (GET), edit a draft (PATCH), delete a draft (DELETE). */
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const page = Math.max(1, Number(new URL(req.url).searchParams.get('page') ?? '1'));

  const [statusCounts, recipients, groups, mailboxes, me] = await Promise.all([
    prisma.recruiterBlastRecipient.groupBy({ by: ['status'], where: { blastId: blast.id }, _count: { _all: true } }),
    prisma.recruiterBlastRecipient.findMany({
      where: { blastId: blast.id },
      orderBy: [{ openCount: 'desc' }, { email: 'asc' }],
      skip: (page - 1) * 200,
      take: 200,
      select: { email: true, name: true, status: true, skipReason: true, sentAt: true, openedAt: true, openCount: true },
    }),
    prisma.recruiterBlastGroup.findMany({
      where: { blastId: blast.id },
      orderBy: { seq: 'asc' },
      take: 500,
      select: { id: true, seq: true, status: true, recipientCount: true, fromEmail: true, sentAt: true, openCount: true, firstOpenedAt: true, lastOpenedAt: true, error: true },
    }),
    sendableMailboxes(session),
    prisma.user.findUnique({ where: { id: session.userId }, select: { emailSignature: true } }),
  ]);
  const usage = await Promise.all(mailboxes.map(async (m) => ({ id: m.id, sentLast24h: (await usageLast24h(m.id)).messages })));
  const counts = Object.fromEntries(statusCounts.map((c) => [c.status, c._count._all]));

  return NextResponse.json({
    blast,
    counts: { total: Object.values(counts).reduce((n: number, v) => n + (v as number), 0), ...counts },
    recipients,
    page,
    groups,
    mailboxes: mailboxes.map((m) => ({ ...m, sentLast24h: usage.find((u) => u.id === m.id)?.sentLast24h ?? 0, dailyLimit: dailyLimit() })),
    hasSignature: !!me?.emailSignature?.trim(),
  });
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  mode: z.enum(['BCC', 'INDIVIDUAL']).optional(),
  toAddress: z.string().trim().max(320).nullable().optional(),
  subject: z.string().max(300).optional(),
  body: z.string().max(500_000).optional(),
  format: z.enum(['text', 'html']).optional(),
  includeSignature: z.boolean().optional(),
  fromName: z.string().trim().max(100).nullable().optional(),
  replyTo: z.string().trim().max(320).nullable().optional(),
  accountIds: z.array(z.string()).max(10).optional(),
  attachmentDocumentIds: z.array(z.string()).max(5).optional(),
  groupSize: z.number().int().min(1).max(MAX_GROUP_SIZE).optional(),
  gapSeconds: z.number().int().min(3).max(3600).optional(),
  /** Most recruiters per mailbox for this send ({ accountId: number }); 0 / missing = no extra limit. */
  accountLimits: z.record(z.string(), z.number().int().min(0).max(100_000)).optional(),
  /** Only a link video is set here; an attached one comes from …/video after its upload. */
  videoLink: z.object({ url: z.string().max(2000), title: z.string().max(120) }).nullable().optional(),
});

export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (blast.status !== 'DRAFT') return NextResponse.json({ error: 'Only a draft can be edited. Use Copy to send it again with changes.' }, { status: 409 });
  const body = patchSchema.parse(await req.json());

  if (body.toAddress && !isValidEmail(body.toAddress)) return NextResponse.json({ error: 'The visible "To" address is not a valid email address.' }, { status: 400 });
  if (body.replyTo && !isValidEmail(body.replyTo)) return NextResponse.json({ error: 'Reply-To is not a valid email address.' }, { status: 400 });
  if (body.accountIds) {
    const allowed = new Set((await sendableMailboxes(session)).map((m) => m.id));
    if (body.accountIds.some((id) => !allowed.has(id))) return NextResponse.json({ error: 'You can only send from your own mailbox or teammates’ opted-in backup mailboxes.' }, { status: 400 });
  }
  const mode = (body.mode ?? blast.mode) as BlastMode;
  const gapSeconds = body.gapSeconds !== undefined || body.mode ? Math.max(MIN_GAP[mode], body.gapSeconds ?? blast.gapSeconds) : undefined;

  const next = { body: body.body ?? blast.body, format: body.format ?? blast.format, includeSignature: body.includeSignature ?? blast.includeSignature };
  let video = readVideo(blast.video);
  if (body.videoLink !== undefined) {
    if (body.videoLink === null) video = video?.mode === 'link' ? null : video;
    else {
      const parsed = videoSchema.safeParse({ mode: 'link', url: body.videoLink.url.trim(), title: body.videoLink.title.trim() || 'Watch the video' });
      if (!parsed.success) return NextResponse.json({ error: 'The video link must be a full https:// link (Google Drive, YouTube…).' }, { status: 400 });
      video = parsed.data;
    }
  }
  const me = await prisma.user.findUnique({ where: { id: session.userId }, select: { emailSignature: true } });
  const built = buildBody({
    body: next.body,
    format: next.format,
    signature: next.includeSignature && me?.emailSignature?.trim() ? me.emailSignature : null,
    videoCard: video?.mode === 'link' ? videoLinkCard(video.url, video.title) : null,
  });

  const updated = await prisma.recruiterBlast.update({
    where: { id: blast.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.mode !== undefined ? { mode: body.mode } : {}),
      ...(body.toAddress !== undefined ? { toAddress: body.toAddress || null } : {}),
      ...(body.subject !== undefined ? { subject: body.subject } : {}),
      ...(body.fromName !== undefined ? { fromName: body.fromName || null } : {}),
      ...(body.replyTo !== undefined ? { replyTo: body.replyTo || null } : {}),
      ...(body.accountIds !== undefined ? { accountIds: [...new Set(body.accountIds)] } : {}),
      ...(body.attachmentDocumentIds !== undefined ? { attachmentDocumentIds: [...new Set(body.attachmentDocumentIds)] } : {}),
      ...(body.groupSize !== undefined ? { groupSize: body.groupSize } : {}),
      ...(gapSeconds !== undefined ? { gapSeconds } : {}),
      ...(body.accountLimits !== undefined ? { accountLimits: Object.fromEntries(Object.entries(body.accountLimits).filter(([, v]) => v > 0)) } : {}),
      ...(body.videoLink !== undefined ? { video: video ? (video as unknown as Prisma.InputJsonValue) : Prisma.JsonNull } : {}),
      body: next.body,
      format: next.format,
      includeSignature: next.includeSignature,
      html: built.html,
      plainText: built.plainText,
    },
  });
  return NextResponse.json({ blast: updated });
});

export const DELETE = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (blast.status !== 'DRAFT') return NextResponse.json({ error: 'Only drafts can be deleted; sent ones stay for the record.' }, { status: 409 });
  await prisma.recruiterBlast.delete({ where: { id: blast.id } });
  await audit(session, 'RECRUITER_SEND_DELETE', { targetType: 'RecruiterBlast', targetId: blast.id });
  return NextResponse.json({ ok: true });
});
