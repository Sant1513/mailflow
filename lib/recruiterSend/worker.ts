import { waitUntil } from '@vercel/functions';
import { prisma } from '@/lib/db/client';
import { appBaseUrl } from '@/lib/app-url';
import { GmailProvider } from '@/lib/email/gmail';
import { SendEmailError, type EmailAttachment } from '@/lib/email/provider';
import { backoffUntil, usageLast24h, wouldExceedDaily } from '@/lib/queue/drain';
import { decorate, type BlastMode } from '@/lib/recruiterSend/core';
import { readVideo } from '@/lib/recruiterSend/video';
import { sendViaUpload, UPLOAD_THRESHOLD_BYTES } from '@/lib/recruiterSend/gmailUpload';
import { readRef } from '@/lib/storage/files';

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

export function kickRecruiterWorker(reason = 'kick'): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  const base = process.env.INTERNAL_APP_URL?.replace(/\/+$/, '') || appBaseUrl();
  const controller = new AbortController();
  const call = fetch(`${base}/api/cron/recruiter-send?reason=${encodeURIComponent(reason)}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: controller.signal,
  }).catch(() => undefined);
  const hangUp = new Promise<void>((resolve) => setTimeout(() => { controller.abort(); resolve(); }, 2_500));
  try {
    waitUntil(Promise.race([call, hangUp]));
  } catch {
    /* not on Vercel: runs on its own */
  }
}

async function recoverStuck() {
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

/** Recruiters each mailbox has already sent to in this send. */
async function sentPerAccount(blastId: string): Promise<Map<string, number>> {
  const rows = await prisma.recruiterBlastGroup.groupBy({ by: ['accountId'], where: { blastId, status: 'SENT' }, _sum: { recipientCount: true } });
  return new Map(rows.filter((r) => r.accountId).map((r) => [r.accountId!, r._sum.recipientCount ?? 0]));
}

/**
 * Picks the mailbox for a message, or explains why none can send right now: in the chosen
 * order, skipping mailboxes that are disconnected, paused by Gmail, at Google's daily limits,
 * or at the limit the admin set for this send.
 */
async function chooseMailbox(blast: { id: string; accountIds: string[]; accountLimits: unknown }, to: string, bcc: string[]) {
  const reasons: string[] = [];
  const limits = (blast.accountLimits && typeof blast.accountLimits === 'object' ? blast.accountLimits : {}) as Record<string, number>;
  const used = await sentPerAccount(blast.id);
  const size = bcc.length || 1;
  for (const id of blast.accountIds) {
    const account = await prisma.emailProviderAccount.findUnique({ where: { id } });
    if (!account || account.status !== 'CONNECTED' || !account.refreshTokenEnc) {
      reasons.push(`${account?.emailAddress ?? 'a mailbox'} is disconnected`);
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
    if (wouldExceedDaily(usage, { toEmail: to, ccEmails: [], bccEmails: bcc })) {
      reasons.push(`${account.emailAddress} has reached its daily limit`);
      continue;
    }
    return { account, reasons };
  }
  return { account: null, reasons };
}

export async function runRecruiterWorker(opts: { budgetMs?: number } = {}): Promise<{ sent: number; failed: number; waiting: string | null }> {
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);
  let sent = 0;
  let failed = 0;
  let waiting: string | null = null;
  await recoverStuck();

  // Scheduled sends whose time has come.
  await prisma.recruiterBlast.updateMany({ where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } }, data: { status: 'SENDING', startedAt: new Date() } });

  while (Date.now() < deadline - 5_000) {
    const blasts = await prisma.recruiterBlast.findMany({ where: { status: 'SENDING' }, orderBy: { startedAt: 'asc' }, take: 20 });
    if (!blasts.length) break;
    let progressed = false;

    for (const blast of blasts) {
      if (Date.now() >= deadline - 5_000) break;
      if (await finishIfDone(blast.id)) continue;

      // Pause between messages of the same send.
      const last = await prisma.recruiterBlastGroup.findFirst({ where: { blastId: blast.id, status: 'SENT' }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } });
      const wait = last?.sentAt ? last.sentAt.getTime() + blast.gapSeconds * 1000 - Date.now() : 0;
      if (wait > 0) {
        if (wait > deadline - Date.now() - 5_000) continue;
        await sleep(wait);
      }

      const group = await prisma.recruiterBlastGroup.findFirst({ where: { blastId: blast.id, status: 'PENDING' }, orderBy: { seq: 'asc' } });
      if (!group) continue;
      const recipients = await prisma.recruiterBlastRecipient.findMany({ where: { groupId: group.id, status: { in: ['PENDING', 'QUEUED'] } }, select: { id: true, email: true } });
      if (!recipients.length) {
        await prisma.recruiterBlastGroup.update({ where: { id: group.id }, data: { status: 'SENT', sentAt: new Date(), recipientCount: 0 } });
        continue;
      }

      const mode = blast.mode as BlastMode;
      const to = mode === 'BCC' ? blast.toAddress! : recipients[0]!.email;
      const bcc = mode === 'BCC' ? recipients.map((r) => r.email) : [];
      const { account, reasons } = await chooseMailbox(blast, to, bcc);
      if (!account) {
        waiting = `Waiting: ${reasons.join('; ') || 'no sending mailbox chosen'}. Sending carries on by itself when one is free.`;
        if (blast.note !== waiting) await prisma.recruiterBlast.update({ where: { id: blast.id }, data: { note: waiting } });
        continue;
      }

      // Claim it: only one run may send this message.
      const claimed = await prisma.recruiterBlastGroup.updateMany({ where: { id: group.id, status: 'PENDING' }, data: { status: 'SENDING', accountId: account.id, fromEmail: account.emailAddress, attempts: { increment: 1 } } });
      if (!claimed.count) continue;
      progressed = true;

      const decorated = decorate(blast.html, { groupId: group.id, mode, workspaceId: blast.workspaceId, blastId: blast.id, recipientEmail: mode === 'INDIVIDUAL' ? to : undefined });
      const docs = blast.attachmentDocumentIds.length
        ? await prisma.documentTemplate.findMany({ where: { id: { in: blast.attachmentDocumentIds } }, select: { id: true, fileNamePattern: true, file: { select: { data: true } } } })
        : [];
      try {
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
          bcc,
          fromName: blast.fromName || account.displayName || account.emailAddress,
          fromEmail: account.emailAddress,
          replyTo: blast.replyTo ?? undefined,
          subject: blast.subject,
          html: decorated.html,
          plainText: `${blast.plainText}\n\nUnsubscribe: ${decorated.unsubscribeUrl}`,
          // One-click unsubscribe only where it can name the person (individual copies).
          listUnsubscribeUrl: mode === 'INDIVIDUAL' ? decorated.unsubscribeUrl : null,
          attachments,
        };
        // Big messages (a video) go through Gmail's upload endpoint, which takes up to 35 MB.
        const bytes = attachments.reduce((n, a) => n + a.content.length, 0);
        const result = bytes > UPLOAD_THRESHOLD_BYTES ? await sendViaUpload(account, input) : await new GmailProvider(account).sendEmail(input);
        const now = new Date();
        await prisma.$transaction([
          prisma.recruiterBlastGroup.update({ where: { id: group.id }, data: { status: 'SENT', sentAt: now, gmailMessageId: result.providerMessageId, errorCode: null, error: null, recipientCount: recipients.length } }),
          prisma.recruiterBlastRecipient.updateMany({ where: { groupId: group.id, status: { in: ['PENDING', 'QUEUED'] } }, data: { status: 'SENT', sentAt: now } }),
          prisma.recruiterBlast.update({ where: { id: blast.id }, data: { note: null } }),
        ]);
        sent++;
      } catch (err) {
        const e = err instanceof SendEmailError ? err : new SendEmailError((err as Error).message ?? 'Unknown error', 'UNKNOWN');
        const message = e.message.slice(0, 500);
        // Gmail pushed back / quota / auth: put it back for another mailbox or later; the error
        // (with sentAt = now) makes backoffUntil hold this mailbox (lib/queue/drain.ts).
        const retry = e.kind !== 'INVALID_RECIPIENT' && group.attempts + 1 < MAX_ATTEMPTS;
        if (e.kind === 'AUTH') await prisma.emailProviderAccount.update({ where: { id: account.id }, data: { status: 'EXPIRED' } }).catch(() => undefined);
        await prisma.recruiterBlastGroup.update({
          where: { id: group.id },
          data: {
            status: retry || e.kind === 'RATE_LIMIT' || e.kind === 'QUOTA' || e.kind === 'AUTH' ? 'PENDING' : 'FAILED',
            errorCode: e.kind,
            error: message,
            sentAt: new Date(),
          },
        });
        if (!(retry || e.kind === 'RATE_LIMIT' || e.kind === 'QUOTA' || e.kind === 'AUTH')) {
          await prisma.recruiterBlastRecipient.updateMany({ where: { groupId: group.id, status: { in: ['PENDING', 'QUEUED'] } }, data: { status: 'FAILED', skipReason: message.slice(0, 200) } });
          failed++;
        }
      }
    }
    if (!progressed) break;
  }

  const more = await prisma.recruiterBlast.count({ where: { status: 'SENDING' } });
  if (more && !waiting) kickRecruiterWorker('continue');
  return { sent, failed, waiting };
}
