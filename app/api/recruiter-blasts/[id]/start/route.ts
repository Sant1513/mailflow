import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { loadBlast, requireBlastAdmin } from '@/lib/recruiterSend/access';
import { planBlast } from '@/lib/recruiterSend/plan';
import { planGroups, type BlastMode } from '@/lib/recruiterSend/core';
import { readVideo, VIDEO_INDIVIDUAL_MAX } from '@/lib/recruiterSend/video';
import { kickRecruiterWorker } from '@/lib/recruiterSend/worker';
import { isValidEmail } from '@/lib/quickSend/prepare';

/**
 * Starts (or schedules) a draft recruiter send: final checks, skipped recruiters marked with
 * their reason, the rest split into Gmail messages (BCC groups or individual copies), then
 * the sender is started. Nothing is sent from here directly.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_ATTACH_BYTES = 22 * 1024 * 1024; // Gmail takes 25 MB per message, minus encoding room

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (blast.status !== 'DRAFT') return NextResponse.json({ error: 'This send has already started.' }, { status: 409 });
  const { scheduledAt } = z.object({ scheduledAt: z.string().datetime({ offset: true }).nullable().optional() }).parse(await req.json().catch(() => ({})));

  const mode = blast.mode as BlastMode;
  const problems: string[] = [];
  if (!blast.subject.trim()) problems.push('Add a subject.');
  if (!blast.body.trim()) problems.push('Write the message.');
  if (mode === 'BCC' && (!blast.toAddress || !isValidEmail(blast.toAddress))) problems.push('BCC sends need a visible "To" address.');
  if (!blast.accountIds.length) problems.push('Choose at least one mailbox to send from.');
  const connected = blast.accountIds.length
    ? await prisma.emailProviderAccount.count({ where: { id: { in: blast.accountIds }, status: 'CONNECTED' } })
    : 0;
  if (blast.accountIds.length && !connected) problems.push('None of the chosen mailboxes is connected.');

  const docs = blast.attachmentDocumentIds.length
    ? await prisma.documentTemplate.findMany({ where: { id: { in: blast.attachmentDocumentIds }, workspaceId: blast.workspaceId, archived: false }, select: { id: true, file: { select: { size: true } } } })
    : [];
  if (docs.length !== blast.attachmentDocumentIds.length) problems.push('An attached PDF is no longer available; remove it and attach it again.');
  const video = readVideo(blast.video);
  const attachBytes = docs.reduce((n, d) => n + d.file.size, 0) + (video?.mode === 'attach' ? video.size : 0);
  if (attachBytes > MAX_ATTACH_BYTES) problems.push(`Attachments add up to ${(attachBytes / 1048576).toFixed(1)} MB; keep them under ${MAX_ATTACH_BYTES / 1048576} MB (share a big video as a link).`);

  const plan = await planBlast(blast);
  if (!plan.eligibleIds.length) problems.push('Nobody to send to: add recruiters, or check why they were skipped.');
  if (video?.mode === 'attach' && mode === 'INDIVIDUAL' && plan.eligibleIds.length > VIDEO_INDIVIDUAL_MAX) {
    problems.push(`An attached video can go to at most ${VIDEO_INDIVIDUAL_MAX} recruiters as individual copies (each copy downloads it again). Use BCC groups, or share the video as a link.`);
  }
  if (problems.length) return NextResponse.json({ error: problems.join(' ') }, { status: 400 });

  const when = scheduledAt ? new Date(scheduledAt) : null;
  if (when && when.getTime() < Date.now() - 60_000) return NextResponse.json({ error: 'The scheduled time is in the past.' }, { status: 400 });

  const groups = planGroups(plan.eligibleIds, mode, blast.groupSize);
  await prisma.$transaction(
    async (tx) => {
      // Skipped recruiters keep their reason.
      for (const [id, reason] of plan.skippedReasons) {
        await tx.recruiterBlastRecipient.update({ where: { id }, data: { status: 'SKIPPED', skipReason: reason.slice(0, 300) } });
      }
      const created = await tx.recruiterBlastGroup.createManyAndReturn({
        data: groups.map((g, i) => ({ blastId: blast.id, seq: i + 1, recipientCount: g.length })),
        select: { id: true, seq: true },
      });
      const bySeq = new Map(created.map((c) => [c.seq, c.id]));
      const recipientIds: string[] = [];
      const groupIds: string[] = [];
      groups.forEach((g, i) => g.forEach((rid) => { recipientIds.push(rid); groupIds.push(bySeq.get(i + 1)!); }));
      for (let i = 0; i < recipientIds.length; i += 5000) {
        await tx.$executeRaw`
          UPDATE "RecruiterBlastRecipient" AS r SET "groupId" = v.g, "status" = 'QUEUED'
          FROM unnest(${recipientIds.slice(i, i + 5000)}::text[], ${groupIds.slice(i, i + 5000)}::text[]) AS v(id, g)
          WHERE r."id" = v.id`;
      }
      await tx.recruiterBlast.update({
        where: { id: blast.id },
        data: { status: when ? 'SCHEDULED' : 'SENDING', scheduledAt: when, startedAt: when ? null : new Date(), note: null },
      });
    },
    { timeout: 55_000, maxWait: 10_000 },
  );

  await audit(session, 'RECRUITER_SEND_START', {
    targetType: 'RecruiterBlast',
    targetId: blast.id,
    metadata: { mode, recipients: plan.eligibleIds.length, skipped: plan.skippedReasons.size, messages: groups.length, accounts: blast.accountIds, scheduledAt: when?.toISOString() ?? null },
  });
  if (!when) kickRecruiterWorker('start');
  return NextResponse.json({ ok: true, status: when ? 'SCHEDULED' : 'SENDING', recipients: plan.eligibleIds.length, skipped: plan.skippedReasons.size, messages: groups.length });
});
