import { waitUntil } from '@vercel/functions';
import { prisma } from '@/lib/db/client';
import { appBaseUrl } from '@/lib/app-url';
import { GmailProvider } from '@/lib/email/gmail';
import { SendEmailError, type EmailAttachment, type SendEmailInput } from '@/lib/email/provider';
import type { EmailProviderAccount } from '@prisma/client';
import { backoffUntil, usageLast24h, wouldExceedDaily } from '@/lib/queue/drain';
import { decorate, replyToHeader, type BlastMode } from '@/lib/recruiterSend/core';
import { readVideo } from '@/lib/recruiterSend/video';
import { personalize } from '@/lib/recruiterSend/personalize';
import { sendViaUpload, UPLOAD_THRESHOLD_BYTES } from '@/lib/recruiterSend/gmailUpload';
import { readRef } from '@/lib/storage/files';
import { allowedMailboxIds } from '@/lib/recruiterSend/access';
import { markRecruiterBounced, suppressRejectedRecruiter } from '@/lib/recruiterSend/replies';

/**
 * Sends Recruiter Bulk Send messages, one Gmail message at a time (a BCC group or one
 * individual copy), with the blast's pause between messages. Each message goes from the first
 * chosen mailbox that is connected, not paused by Gmail and still under its daily limits
 * (shared with campaigns, lib/queue/drain.ts) — so the next mailbox takes over when one is
 * full. Runs ~45 s per call and hands over to a fresh call (kickRecruiterWorker) while work
 * remains; the 15-minute schedule is the backstop.
 *
 * Safety: a message is claimed (PENDING → SENDING) before it is sent, so two runs can't send
 * it twice; one left SENDING by a crash is never re-sent automatically (it may already be out),
 * it is marked failed with a note to check the Sent folder.
 */
const MAX_ATTEMPTS = 3;
const STUCK_MS = 10 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const videoCache = new Map<string, Buffer>();

/**
 * Starts a fresh sender run. `wait: true` returns only once the request has had time to reach
 * the server (used at the end of a run: a fire-and-forget hand-over was sometimes dropped when
 * the run finished first, and the send sat still until the next backstop).
 */
export function kickRecruiterWorker(reason = 'kick', opts: { wait?: boolean } = {}): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Promise.resolve();
  const base = process.env.INTERNAL_APP_URL?.replace(/\/+$/, '') || appBaseUrl();
  const controller = new AbortController();
  const call = fetch(`${base}/api/cron/recruiter-send?reason=${encodeURIComponent(reason)}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: controller.signal,
  }).then(() => undefined, () => undefined);
  const hangUp = new Promise<void>((resolve) => setTimeout(() => { controller.abort(); resolve(); }, opts.wait ? 4_000 : 2_500));
  const done = Promise.race([call, hangUp]);
  if (opts.wait) return done;
  try {
    waitUntil(done);
  } catch {
    /* not on Vercel: runs on its own */
  }
  return Promise.resolve();
}

/**
 * Watchdog: sends that should be moving but haven't sent (or claimed) anything for longer than
 * their pause plus a margin get a fresh run. Called when someone looks at the send pages and by
 * the laptop backstop, so a dropped hand-over never leaves a send sitting still.
 */
const lastWatchdogKick = { at: 0 };
export async function nudgeStuckSends(reason = 'watchdog'): Promise<number> {
  if (Date.now() - lastWatchdogKick.at < 30_000) return 0;
  const sending = await prisma.recruiterBlast.findMany({ where: { status: 'SENDING' }, select: { id: true, gapSeconds: true, startedAt: true } });
  let stuck = 0;
  for (const b of sending) {
    const last = await prisma.recruiterBlastGroup.findFirst({ where: { blastId: b.id, sentAt: { not: null } }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } });
    const since = (last?.sentAt ?? b.startedAt ?? new Date(0)).getTime();
    if (Date.now() - since > (b.gapSeconds + 75) * 1000) stuck++;
  }
  if (!stuck) return 0;
  lastWatchdogKick.at = Date.now();
  await kickRecruiterWorker(reason);
  return stuck;
}

async function recoverStuck() {
  // A claim stamps sentAt with the claim time, so only claims older than STUCK_MS count as stuck.
  const stuck = await prisma.recruiterBlastGroup.findMany({
    where: { status: 'SENDING', createdAt: { lt: new Date(Date.now() - STUCK_MS) }, OR: [{ sentAt: null }, { sentAt: { lt: new Date(Date.now() - STUCK_MS) } }] },
    select: { id: true },
  });
  for (const g of stuck) {
    await prisma.recruiterBlastGroup.update({
      where: { id: g.id },
      data: { status: 'FAILED', errorCode: 'UNCERTAIN', error: 'Sending was interrupted; it may or may not have gone out. Check the Sent folder of the mailbox before sending these again.' },
    });
    await prisma.recruiterBlastRecipient.updateMany({ where: { groupId: g.id, status: 'QUEUED' }, data: { status: 'FAILED', skipReason: 'Sending was interrupted (check the Sent folder)' } });
  }
}

async function finishIfDone(blastId: string): Promise<boolean> {
  const left = await prisma.recruiterBlastGroup.count({ where: { blastId, status: { in: ['PENDING', 'SENDING'] } } });
  if (left) return false;
  await prisma.recruiterBlast.updateMany({ where: { id: blastId, status: 'SENDING' }, data: { status: 'COMPLETED', completedAt: new Date(), note: null } });
  return true;
}

/** Recruiters each mailbox has already sent to (or is sending to right now) in this send. */
async function sentPerAccount(blastId: string): Promise<Map<string, number>> {
  const rows = await prisma.recruiterBlastGroup.groupBy({ by: ['accountId'], where: { blastId, status: { in: ['SENT', 'SENDING'] } }, _sum: { recipientCount: true } });
  return new Map(rows.filter((r) => r.accountId).map((r) => [r.accountId!, r._sum.recipientCount ?? 0]));
}

/**
 * Picks the mailbox for a message, or explains why none can send right now: in the chosen
 * order, skipping mailboxes that are disconnected, no longer shared as a backup (the
 * teammate withdrew it or left), paused by Gmail, at Google's daily limits, or at the limit
 * the admin set for this send.
 */
async function chooseMailbox(blast: { id: string; organizationId: string; createdById: string; accountIds: string[]; accountLimits: unknown; ccAddresses?: string[] }, to: string, bcc: string[]) {
  const reasons: string[] = [];
  const limits = (blast.accountLimits && typeof blast.accountLimits === 'object' ? blast.accountLimits : {}) as Record<string, number>;
  const [used, allowed] = await Promise.all([sentPerAccount(blast.id), allowedMailboxIds(blast.organizationId, blast.createdById)]);
  const size = bcc.length || 1;
  for (const id of blast.accountIds) {
    const account = await prisma.emailProviderAccount.findUnique({ where: { id } });
    if (!account || account.status !== 'CONNECTED' || !account.refreshTokenEnc) {
      reasons.push(`${account?.emailAddress ?? 'a mailbox'} is disconnected`);
      continue;
    }
    if (!allowed.has(id)) {
      reasons.push(`${account.emailAddress} is no longer shared as a backup mailbox`);
      continue;
    }
    const cap = Number(limits[id]);
    if (Number.isFinite(cap) && cap > 0 && (used.get(id) ?? 0) + size > cap) {
      reasons.push(`${account.emailAddress} reached the limit you set (${cap})`);
      continue;
    }
    if ((await backoffUntil(id)) > 0) {
      reasons.push(`${account.emailAddress} is paused by Gmail for a while`);
      continue;
    }
    const usage = await usageLast24h(id);
    if (wouldExceedDaily(usage, { toEmail: to, ccEmails: blast.ccAddresses ?? [], bccEmails: bcc })) {
      reasons.push(`${account.emailAddress} has reached its daily limit`);
      continue;
    }
    return { account, reasons };
  }
  return { account: null, reasons };
}

/** Sends one message; replaceable in tests so no real email goes out. */
export type RecruiterSender = (account: EmailProviderAccount, input: SendEmailInput, large: boolean) => Promise<{ providerMessageId: string; threadId?: string | null; messageIdHeader?: string | null }>;
const gmailSender: RecruiterSender = (account, input, large) => (large ? sendViaUpload(account, input) : new GmailProvider(account).sendEmail(input));

export async function runRecruiterWorker(opts: { budgetMs?: number; send?: RecruiterSender } = {}): Promise<{ sent: number; failed: number; waiting: string | null }> {
  const send = opts.send ?? gmailSender;
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);
  const timeLeft = () => deadline - 5_000 - Date.now();
  // A Gmail send (150 Bcc, maybe a video) can take 10-20 s. Never start one this close to the end:
  // the run would hit the 60 s function limit and be killed before handing over to the next run,
  // and the send would sit still (it stalled after 3 batches twice).
  const SEND_RESERVE_MS = 18_000;
  let handOver = false;
  let sent = 0;
  let failed = 0;
  let waiting: string | null = null;
  const waitingIds = new Set<string>();
  await recoverStuck();

  // Scheduled sends whose time has come.
  await prisma.recruiterBlast.updateMany({ where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } }, data: { status: 'SENDING', startedAt: new Date() } });

  while (timeLeft() > 0) {
    const blasts = await prisma.recruiterBlast.findMany({ where: { status: 'SENDING' }, orderBy: { startedAt: 'asc' }, take: 20 });
    if (!blasts.length) break;
    let progressed = false;
    let nextGap = Infinity; // shortest pause still to run, when every send is between messages

    for (const blast of blasts) {
      if (timeLeft() <= 0) break;
      if (await finishIfDone(blast.id)) continue;

      // Pause between messages of the same send (counting one being sent right now).
      const last = await prisma.recruiterBlastGroup.findFirst({ where: { blastId: blast.id, status: { in: ['SENT', 'SENDING'] }, sentAt: { not: null } }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } });
      const wait = last?.sentAt ? last.sentAt.getTime() + blast.gapSeconds * 1000 - Date.now() : 0;
      if (wait > 0) {
        if (wait > timeLeft() - SEND_RESERVE_MS) {
          nextGap = Math.min(nextGap, wait);
          continue;
        }
        await sleep(wait);
        // Paused or cancelled while we waited?
        const current = await prisma.recruiterBlast.findUnique({ where: { id: blast.id }, select: { status: true } });
        if (current?.status !== 'SENDING') continue;
      }

      const group = await prisma.recruiterBlastGroup.findFirst({ where: { blastId: blast.id, status: 'PENDING' }, orderBy: { seq: 'asc' } });
      if (!group) continue;
      let recipients = await prisma.recruiterBlastRecipient.findMany({ where: { groupId: group.id, status: { in: ['PENDING', 'QUEUED'] } }, select: { id: true, email: true, name: true, data: true } });
      // Unsubscribed or bounced since the send started (a long send runs for days): drop them.
      if (recipients.length) {
        const suppressed = await prisma.emailSuppression.findMany({ where: { workspaceId: blast.workspaceId, email: { in: recipients.map((r) => r.email) } }, select: { email: true } });
        if (suppressed.length) {
          const gone = new Set(suppressed.map((s) => s.email.toLowerCase()));
          const drop = recipients.filter((r) => gone.has(r.email.toLowerCase()));
          await prisma.recruiterBlastRecipient.updateMany({ where: { id: { in: drop.map((r) => r.id) } }, data: { status: 'SKIPPED', skipReason: 'Unsubscribed or bounced after the send started' } });
          recipients = recipients.filter((r) => !gone.has(r.email.toLowerCase()));
        }
      }
      if (!recipients.length) {
        await prisma.recruiterBlastGroup.updateMany({ where: { id: group.id, status: 'PENDING' }, data: { status: 'SENT', recipientCount: 0 } });
        progressed = true;
        continue;
      }

      const mode = blast.mode as BlastMode;
      const to = mode === 'BCC' ? blast.toAddress! : recipients[0]!.email;
      const bcc = mode === 'BCC' ? recipients.map((r) => r.email) : [];
      const { account, reasons } = await chooseMailbox(blast, to, bcc);
      if (!account) {
        waiting = `Waiting: ${reasons.join('; ') || 'no sending mailbox chosen'}. Sending carries on by itself when one is free.`;
        waitingIds.add(blast.id);
        if (blast.note !== waiting) await prisma.recruiterBlast.update({ where: { id: blast.id }, data: { note: waiting } });
        continue;
      }

      if (timeLeft() < SEND_RESERVE_MS) {
        handOver = true; // not enough time left to send safely: let the next run do it
        break;
      }

      // Claim it: only one run may send this message, and only one message of a send is out at
      // a time (so two runs can't skip the pause). sentAt = claim time keeps recoverStuck off
      // fresh claims; the old error is cleared so it can't hold the mailbox (backoffUntil).
      const claimed = await prisma.recruiterBlastGroup.updateMany({
        where: { id: group.id, status: 'PENDING', blast: { status: 'SENDING', groups: { none: { status: 'SENDING' } } } },
        data: { status: 'SENDING', sentAt: new Date(), accountId: account.id, fromEmail: account.emailAddress, attempts: { increment: 1 }, errorCode: null, error: null },
      });
      if (!claimed.count) continue;
      progressed = true;

      // Individual copies carry the recruiter's own {{Column}} values (name, company, UTM link).
      const content = mode === 'INDIVIDUAL' ? personalize({ subject: blast.subject, html: blast.html, plainText: blast.plainText }, recipients[0]!) : { subject: blast.subject, html: blast.html, plainText: blast.plainText };
      const decorated = decorate(content.html, { groupId: group.id, mode, workspaceId: blast.workspaceId, blastId: blast.id, recipientEmail: mode === 'INDIVIDUAL' ? to : undefined, pixel: mode === 'INDIVIDUAL' });
      let result: Awaited<ReturnType<RecruiterSender>>;
      try {
        const docs = blast.attachmentDocumentIds.length
          ? await prisma.documentTemplate.findMany({ where: { id: { in: blast.attachmentDocumentIds }, workspaceId: blast.workspaceId }, select: { id: true, fileNamePattern: true, file: { select: { data: true } } } })
          : [];
        const attachments: EmailAttachment[] = blast.attachmentDocumentIds
          .map((id) => docs.find((d) => d.id === id))
          .filter((d): d is NonNullable<typeof d> => !!d)
          .map((d) => ({ filename: /\.pdf$/i.test(d.fileNamePattern) ? d.fileNamePattern : `${d.fileNamePattern}.pdf`, mimeType: 'application/pdf', content: Buffer.from(d.file.data) }));
        const video = readVideo(blast.video);
        if (video?.mode === 'attach') {
          // Downloaded once per run, not once per message.
          let bytes = videoCache.get(video.ref);
          if (!bytes) {
            bytes = (await readRef(video.ref)) ?? undefined;
            if (!bytes) throw new SendEmailError('The video could not be read from storage.', 'TRANSIENT');
            videoCache.set(video.ref, bytes);
          }
          attachments.push({ filename: video.fileName, mimeType: video.contentType, content: bytes });
        }
        const input = {
          to,
          cc: blast.ccAddresses,
          bcc,
          fromName: blast.fromName || account.displayName || account.emailAddress,
          fromEmail: account.emailAddress,
          // Custom Reply-To plus the sending mailbox, so replies reach MailFlow too.
          replyTo: replyToHeader(blast.replyTo, account.emailAddress),
          subject: content.subject,
          html: decorated.html,
          plainText: `${content.plainText}\n\nUnsubscribe: ${decorated.unsubscribeUrl}`,
          // One-click unsubscribe only where it can name the person (individual copies).
          listUnsubscribeUrl: mode === 'INDIVIDUAL' ? decorated.unsubscribeUrl : null,
          attachments,
        };
        // Big messages (a video) go through Gmail's upload endpoint, which takes up to 35 MB.
        const bytes = attachments.reduce((n, a) => n + a.content.length, 0);
        result = await send(account, input, bytes > UPLOAD_THRESHOLD_BYTES);
      } catch (err) {
        if (await recordFailure(blast.id, group, account.id, err)) failed++;
        // Gmail refused the recruiter's address itself (individual copies name one person): it
        // goes on the suppression list everywhere, with the reason, and shows "bounced" here.
        if (mode === 'INDIVIDUAL' && err instanceof SendEmailError && err.kind === 'INVALID_RECIPIENT') {
          const detail = `Gmail rejected the address when sending (Recruiter Bulk Send “${blast.name}”): ${err.message}`;
          await suppressRejectedRecruiter(blast.workspaceId, to, detail).catch((e) => console.error('[recruiter-send] suppress failed', e));
          await markRecruiterBounced(blast.id, [to], detail).catch(() => undefined);
        }
        continue;
      }

      // Gmail has it. From here nothing may put the message back in the queue: if recording
      // fails every time, it stays SENDING and recoverStuck marks it "check the Sent folder".
      const sentAt = new Date();
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await prisma.$transaction([
            // The Message-ID and thread let Gmail sync recognise recruiters' replies (lib/gmail/ingest.ts).
            prisma.recruiterBlastGroup.update({ where: { id: group.id }, data: { status: 'SENT', sentAt, gmailMessageId: result.providerMessageId, messageIdHeader: result.messageIdHeader ?? null, gmailThreadId: result.threadId ?? null, errorCode: null, error: null, recipientCount: recipients.length } }),
            prisma.recruiterBlastRecipient.updateMany({ where: { groupId: group.id, status: { in: ['PENDING', 'QUEUED'] } }, data: { status: 'SENT', sentAt } }),
            prisma.recruiterBlast.update({ where: { id: blast.id }, data: { note: null } }),
          ]);
          break;
        } catch (err) {
          console.error(`[recruiter-send] group ${group.id} was sent but could not be recorded (attempt ${attempt})`, err);
          if (attempt < 3) await sleep(1_000 * attempt);
        }
      }
      sent++;
    }

    if (handOver) break;
    if (!progressed) {
      // Every send is between messages: wait here rather than hand over to a new run that
      // would only find the same pause, but keep enough time to send and hand over.
      const usable = timeLeft() - SEND_RESERVE_MS;
      if (Number.isFinite(nextGap) && usable > 1_000) {
        await sleep(Math.min(nextGap, usable));
        continue;
      }
      break;
    }
  }

  // Hand over while any send can still move; sends waiting for a mailbox resume on the schedule.
  const more = await prisma.recruiterBlast.count({ where: { status: 'SENDING', id: { notIn: [...waitingIds] } } });
  if (more) await kickRecruiterWorker('continue', { wait: true });
  return { sent, failed, waiting };
}

/**
 * A message Gmail did not take. Pushed back / quota / auth / transient: back in the queue for
 * another mailbox or later (the error with sentAt = now makes backoffUntil hold this mailbox,
 * lib/queue/drain.ts). Otherwise, or after MAX_ATTEMPTS, failed. Returns true when it failed.
 */
async function recordFailure(blastId: string, group: { id: string; attempts: number }, accountId: string, err: unknown): Promise<boolean> {
  const e = err instanceof SendEmailError ? err : new SendEmailError((err as Error)?.message ?? 'Unknown error', 'UNKNOWN');
  const message = e.message.slice(0, 500);
  const retry = e.kind !== 'INVALID_RECIPIENT' && group.attempts + 1 < MAX_ATTEMPTS;
  const requeue = retry || e.kind === 'RATE_LIMIT' || e.kind === 'QUOTA' || e.kind === 'AUTH';
  if (e.kind === 'AUTH') await prisma.emailProviderAccount.update({ where: { id: accountId }, data: { status: 'EXPIRED' } }).catch(() => undefined);
  // Cancelled meanwhile: don't leave it queued for good.
  const blast = await prisma.recruiterBlast.findUnique({ where: { id: blastId }, select: { status: true } });
  const cancelled = blast?.status === 'CANCELLED';
  await prisma.recruiterBlastGroup.update({
    where: { id: group.id },
    data: { status: requeue && !cancelled ? 'PENDING' : 'FAILED', errorCode: e.kind, error: cancelled ? 'Cancelled before sending' : message, sentAt: new Date() },
  });
  if (cancelled) {
    await prisma.recruiterBlastRecipient.updateMany({ where: { groupId: group.id, status: { in: ['PENDING', 'QUEUED'] } }, data: { status: 'SKIPPED', skipReason: 'Cancelled before sending' } });
    return false;
  }
  if (requeue) return false;
  await prisma.recruiterBlastRecipient.updateMany({ where: { groupId: group.id, status: { in: ['PENDING', 'QUEUED'] } }, data: { status: 'FAILED', skipReason: message.slice(0, 200) } });
  return true;
}
