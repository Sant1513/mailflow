import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { allowedMailboxIds, loadBlast, requireBlastAdmin } from '@/lib/recruiterSend/access';
import { planBlast } from '@/lib/recruiterSend/plan';
import { planGroups, type BlastMode } from '@/lib/recruiterSend/core';
import { readVideo, VIDEO_INDIVIDUAL_MAX } from '@/lib/recruiterSend/video';
import { kickRecruiterWorker, type RunOn } from '@/lib/recruiterSend/worker';
import { currentState, laptopOnline } from '@/lib/system/serverState';
import { isValidEmail } from '@/lib/quickSend/prepare';
import { sendLockReasonOf } from '@/lib/orgs/access';
import { variableCheck } from '@/lib/recruiterSend/personalize';

/**
 * Starts (or schedules) a draft recruiter send: final checks, skipped recruiters marked with
 * their reason, the rest split into Gmail messages (BCC groups or individual copies), then
 * the sender is started. Nothing is sent from here directly.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CC_INDIVIDUAL_MAX = 50;
const MAX_ATTACH_BYTES = 22 * 1024 * 1024; // Gmail takes 25 MB per message, minus encoding room

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (blast.status !== 'DRAFT') return NextResponse.json({ error: 'This send has already started.' }, { status: 409 });
  const { scheduledAt, runOn: wanted } = z
    .object({ scheduledAt: z.string().datetime({ offset: true }).nullable().optional(), runOn: z.enum(['cloud', 'laptop']).optional() })
    .parse(await req.json().catch(() => ({})));

  // Send from the laptop (saves Vercel CPU): only while it is online. When MailFlow already runs
  // on the laptop, every send goes out from there anyway, so it is stored as an ordinary send.
  let runOn: RunOn = 'cloud';
  let alreadyOnLaptop = false;
  if (wanted === 'laptop') {
    const server = await currentState();
    if (server.activeServer === 'laptop') alreadyOnLaptop = true;
    else if (!laptopOnline(server)) {
      return NextResponse.json({ error: 'The laptop is offline, so this send can’t run there. Switch the laptop server on (or check its internet), or send from the cloud.' }, { status: 409 });
    } else runOn = 'laptop';
  }

  const mode = blast.mode as BlastMode;
  const problems: string[] = [];
  if (!blast.subject.trim()) problems.push('Add a subject.');
  if (!blast.body.trim()) problems.push('Write the message.');
  // {{Column}} personalisation: every variable must be a column, and only individual copies can carry it.
  const vars = variableCheck(blast);
  if (vars.unknown.length) problems.push(`${vars.unknown.map((v) => `{{${v}}}`).join(', ')} ${vars.unknown.length === 1 ? 'is not a column' : 'are not columns'} in your recruiter list (columns: ${blast.columns.length ? blast.columns.join(', ') : 'none; paste the list with its header row'}).`);
  if (vars.bccConflict) problems.push(`The email uses ${vars.used.map((v) => `{{${v}}}`).join(', ')}, which needs each recruiter's own copy. Choose "Individual copies", or remove the variables.`);
  if (mode === 'BCC' && (!blast.toAddress || !isValidEmail(blast.toAddress))) problems.push('BCC sends need a visible "To" address.');
  if (!blast.accountIds.length) problems.push('Choose at least one mailbox to send from.');
  const connected = blast.accountIds.length
    ? await prisma.emailProviderAccount.count({ where: { id: { in: blast.accountIds }, status: 'CONNECTED' } })
    : 0;
  if (blast.accountIds.length && !connected) problems.push('None of the chosen mailboxes is connected.');
  // A teammate may have withdrawn their backup mailbox since the draft was saved.
  // An expired or disabled organisation does not send.
  const lockedWhy = await sendLockReasonOf(blast);
  if (lockedWhy) return NextResponse.json({ error: lockedWhy.replace(/^Paused: /, ''), code: 'ORG_LOCKED' }, { status: 402 });
  // Only mailboxes of the organisation this send is made as: never another team's or brand's.
  const allowed = await allowedMailboxIds(blast.organizationId, blast.createdById, blast);
  if (blast.accountIds.some((id) => !allowed.has(id))) problems.push('A chosen mailbox does not belong to this send’s organisation (or is no longer shared as a backup); choose the mailboxes again.');

  const docs = blast.attachmentDocumentIds.length
    ? await prisma.documentTemplate.findMany({ where: { id: { in: blast.attachmentDocumentIds }, workspaceId: blast.workspaceId, archived: false }, select: { id: true, file: { select: { size: true } } } })
    : [];
  if (docs.length !== blast.attachmentDocumentIds.length) problems.push('An attached PDF is no longer available; remove it and attach it again.');
  const video = readVideo(blast.video);
  const attachBytes = docs.reduce((n, d) => n + d.file.size, 0) + (video?.mode === 'attach' ? video.size : 0);
  if (attachBytes > MAX_ATTACH_BYTES) problems.push(`Attachments add up to ${(attachBytes / 1048576).toFixed(1)} MB; keep them under ${MAX_ATTACH_BYTES / 1048576} MB (share a big video as a link).`);

  const plan = await planBlast(blast);
  if (!plan.eligibleIds.length) {
    problems.push(plan.recent.flagged
      ? `Nobody to send to: all ${plan.recent.flagged.toLocaleString()} recruiter(s) were emailed in the last ${plan.recent.windowDays} days. Open “Recruiters” and press “Review and choose” to send to some of them again, or shorten the number of days.`
      : 'Nobody to send to: add recruiters, or check why they were skipped.');
  }
  if (video?.mode === 'attach' && mode === 'INDIVIDUAL' && plan.eligibleIds.length > VIDEO_INDIVIDUAL_MAX) {
    problems.push(`An attached video can go to at most ${VIDEO_INDIVIDUAL_MAX} recruiters as individual copies (each copy downloads it again). Use BCC groups, or share the video as a link.`);
  }
  if (mode === 'INDIVIDUAL' && blast.ccAddresses.length && plan.eligibleIds.length > CC_INDIVIDUAL_MAX) {
    problems.push(`With individual copies, each CC address gets one copy per recruiter; that's at most ${CC_INDIVIDUAL_MAX} recruiters. Use BCC groups, or remove the CC.`);
  }
  // A follow-up that waits for the mailbox that sent the original can only go out from it.
  const isFollowUp = !!blast.parentBlastId;
  if (isFollowUp && blast.followUpMode !== 'NEW' && blast.onMailboxDown === 'WAIT' && plan.followUp?.missingMailboxes.length) {
    const named = await prisma.emailProviderAccount.findMany({ where: { id: { in: plan.followUp.missingMailboxes } }, select: { emailAddress: true } });
    problems.push(`The original email went out from ${named.map((m) => m.emailAddress).join(', ') || 'a mailbox that is not chosen'}. Tick it in "Send from" so the follow-up stays in that thread, or choose “another mailbox (new thread)” when the mailbox is unavailable.`);
  }
  if (problems.length) return NextResponse.json({ error: problems.join(' ') }, { status: 400 });

  const when = scheduledAt ? new Date(scheduledAt) : null;
  if (when && when.getTime() < Date.now() - 60_000) return NextResponse.json({ error: 'The scheduled time is in the past.' }, { status: 400 });

  const groups = isFollowUp ? plan.groupSpecs.map((s) => s.ids) : planGroups(plan.eligibleIds, mode, blast.groupSize);
  await prisma.$transaction(
    async (tx) => {
      // Skipped recruiters keep their reason.
      // One statement per 2,000 skipped recruiters, not one per recruiter: with a remote database each call costs a round trip, and a big
      // send (hundreds skipped) used to spend most of Vercel's 60 seconds on them, then time out without an answer.
      const skippedIds = [...plan.skippedReasons.keys()];
      for (let i = 0; i < skippedIds.length; i += 2000) {
        const ids = skippedIds.slice(i, i + 2000);
        await tx.$executeRaw`
          UPDATE "RecruiterBlastRecipient" AS r SET "status" = 'SKIPPED', "skipReason" = v.reason, "skipKind" = NULLIF(v.kind, '')
          FROM unnest(${ids}::text[], ${ids.map((id) => plan.skippedReasons.get(id)!.slice(0, 300))}::text[], ${ids.map((id) => plan.skippedKinds.get(id) ?? '')}::text[]) AS v(id, reason, kind)
          WHERE r."id" = v.id`;
      }
      const created = await tx.recruiterBlastGroup.createManyAndReturn({
        // Each batch keeps the mailbox the check showed (PARALLEL: round robin across mailboxes).
        data: groups.map((g, i) => ({ blastId: blast.id, seq: i + 1, recipientCount: g.length, plannedAccountId: plan.plannedAccountIds[i] ?? null, inReplyToGroupId: isFollowUp && blast.followUpMode !== 'NEW' ? plan.groupSpecs[i]?.sourceGroupId ?? null : null })),
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
        data: { status: when ? 'SCHEDULED' : 'SENDING', scheduledAt: when, startedAt: when ? null : new Date(), note: null, runOn, runOnChangedAt: null },
      });
    },
    { timeout: 55_000, maxWait: 10_000 },
  );

  await audit(session, 'RECRUITER_SEND_START', {
    targetType: 'RecruiterBlast',
    targetId: blast.id,
    metadata: { mode, sendOrder: plan.sendOrder, rounds: plan.rounds, recipients: plan.eligibleIds.length, skipped: plan.skippedReasons.size, repeatGuard: { windowDays: plan.recent.windowDays, skippedAsRecent: plan.recent.flagged, sendAgain: plan.recent.included, coolOff: plan.recent.coolOff }, messages: groups.length, accounts: blast.accountIds, scheduledAt: when?.toISOString() ?? null, runOn, alreadyOnLaptop, ...(isFollowUp ? { followUpRound: blast.round, parentBlastId: blast.parentBlastId, onMailboxDown: blast.onMailboxDown } : {}) },
  });
  // A laptop send is picked up by the laptop's runner within about 20 seconds: no Vercel run.
  if (!when && runOn === 'cloud') kickRecruiterWorker('start');
  return NextResponse.json({ ok: true, status: when ? 'SCHEDULED' : 'SENDING', recipients: plan.eligibleIds.length, skipped: plan.skippedReasons.size, messages: groups.length, runOn, alreadyOnLaptop });
});
