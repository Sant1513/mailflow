import { waitUntil } from '@vercel/functions';
import { prisma } from '@/lib/db/client';
import { appBaseUrl } from '@/lib/app-url';
import { GmailProvider } from '@/lib/email/gmail';
import { SendEmailError, type EmailAttachment, type SendEmailInput } from '@/lib/email/provider';
import type { EmailProviderAccount, Prisma } from '@prisma/client';
import { backoffUntil, usageLast24h, wouldExceedDaily } from '@/lib/queue/drain';
import { decorate, replyToHeader, type BlastMode } from '@/lib/recruiterSend/core';
import { readVideo } from '@/lib/recruiterSend/video';
import { personalize } from '@/lib/recruiterSend/personalize';
import { sendViaUpload, UPLOAD_THRESHOLD_BYTES } from '@/lib/recruiterSend/gmailUpload';
import { readRef } from '@/lib/storage/files';
import { allowedMailboxIds } from '@/lib/recruiterSend/access';
import { markRecruiterBounced, suppressRejectedRecruiter } from '@/lib/recruiterSend/replies';
import { LAPTOP_SILENT_MS, readState } from '@/lib/system/serverState';
import { audit } from '@/lib/audit/log';

/**
 * Sends Recruiter Bulk Send messages (a BCC group or one individual copy each).
 *  PARALLEL (default): every chosen mailbox sends at once, in rounds — round 1 from all of them,
 *    then each waits its own pause, then round 2 — up to MAX_PARALLEL messages out together.
 *    Each batch has a planned mailbox (start); a mailbox that can't send hands its batches on.
 *  SEQUENTIAL: one message at a time with the send's pause, from the first chosen mailbox that
 *    can send, so the next mailbox takes over when one is full.
 * Mailboxes must be connected, not paused by Gmail and under their daily limits (shared with
 * campaigns, lib/queue/drain.ts) and the limit set for the send. Runs ~45 s per call and hands over to a fresh call (kickRecruiterWorker) while work
 * remains; the 15-minute schedule is the backstop.
 *
 * Send from the laptop (RecruiterBlast.runOn = 'laptop'): Vercel's runs skip those sends; the
 * laptop server's standby runner (laptop-server/recruiter-runner.ts) sends them with this same
 * code on the cloud database, saving Vercel CPU. If the laptop goes silent for 10 minutes the
 * cloud takes them over (takeOverSilentLaptopSends).
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
  const all = await prisma.recruiterBlast.findMany({ where: { status: 'SENDING' }, select: { id: true, gapSeconds: true, startedAt: true, runOn: true } });
  // Sends running on the laptop are its business, unless the laptop has gone quiet.
  const moved = all.some((b) => b.runOn === 'laptop') && !onLaptopServer() ? await takeOverSilentLaptopSends() : [];
  const sending = all.filter((b) => b.runOn !== 'laptop' || moved.includes(b.id) || onLaptopServer());
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

/**
 * Where a send's messages go out from: 'cloud' (Vercel, the default) or 'laptop' (the laptop
 * server's standby runner, laptop-server/recruiter-runner.ts, which saves Vercel's monthly CPU).
 */
export type RunOn = 'cloud' | 'laptop';
/** Which sends one sender run handles: the cloud's, the laptop's, or every send. */
export type RunScope = RunOn | 'all';

/**
 * The app itself is running on the laptop (MailFlow switched to the laptop, start.mjs sets
 * MAILFLOW_SERVER=laptop): it is the only sender then, so it sends every send.
 */
export function onLaptopServer(): boolean {
  return process.env.MAILFLOW_SERVER === 'laptop';
}

function runOnWhere(scope: RunScope): Prisma.RecruiterBlastWhereInput {
  if (scope === 'laptop') return { runOn: 'laptop' };
  if (scope === 'cloud') return { runOn: { not: 'laptop' } };
  return {};
}

/**
 * Laptop sends whose laptop has gone quiet (no heartbeat for LAPTOP_SILENT_MS) move to the
 * cloud, which carries on from where the laptop stopped: messages already claimed by the laptop
 * are never picked up again (claims), and one it left half-sent is marked "check the Sent
 * folder" by recoverStuck. Cheap when nothing runs on the laptop (one count). Returns the ids moved.
 */
export async function takeOverSilentLaptopSends(now = new Date()): Promise<string[]> {
  const live = { runOn: 'laptop', status: { in: ['SENDING', 'SCHEDULED'] } };
  if (!(await prisma.recruiterBlast.count({ where: live }))) return [];
  const s = await readState();
  const silentFor = s.lastLaptopSeenAt ? now.getTime() - s.lastLaptopSeenAt.getTime() : Infinity;
  if (silentFor <= LAPTOP_SILENT_MS) return [];
  const rows = await prisma.recruiterBlast.findMany({ where: live, select: { id: true, organizationId: true, name: true } });
  const moved: string[] = [];
  for (const b of rows) {
    // Conditional, so two cloud runs can't both move (and log) the same send.
    const res = await prisma.recruiterBlast.updateMany({ where: { id: b.id, runOn: 'laptop' }, data: { runOn: 'cloud', runOnChangedAt: now } });
    if (!res.count) continue;
    moved.push(b.id);
    console.log(`[recruiter-send] ${b.id}: the laptop went offline (last seen ${s.lastLaptopSeenAt?.toISOString() ?? 'never'}); the cloud carried on`);
    await audit({ organizationId: b.organizationId }, 'RECRUITER_SEND_MOVED_TO_CLOUD', {
      targetType: 'RecruiterBlast',
      targetId: b.id,
      metadata: { note: 'Laptop went offline; the cloud carried on.', name: b.name, lastLaptopSeenAt: s.lastLaptopSeenAt?.toISOString() ?? null },
    }).catch((err) => console.error('[recruiter-send] audit of the move failed', err));
  }
  return moved;
}

async function recoverStuck(scope: RunScope) {
  // A claim stamps sentAt with the claim time, so only claims older than STUCK_MS count as stuck.
  const stuck = await prisma.recruiterBlastGroup.findMany({
    where: { status: 'SENDING', ...(scope === 'all' ? {} : { blast: runOnWhere(scope) }), createdAt: { lt: new Date(Date.now() - STUCK_MS) }, OR: [{ sentAt: null }, { sentAt: { lt: new Date(Date.now() - STUCK_MS) } }] },
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
 * Can this mailbox send a message of `size` recruiters for this send right now? Disconnected,
 * no longer shared as a backup (the teammate withdrew it or left), paused by Gmail, at the
 * limit the admin set for this send, or at Google's daily limits → the reason why not.
 * Without the real addresses (planning a round), every recruiter counts as a new person for
 * the daily limit, which is the safe side.
 */
async function checkMailbox(
  blast: { accountLimits: unknown; ccAddresses?: string[] },
  id: string,
  size: number,
  ctx: { used: Map<string, number>; allowed: Set<string> },
  exact?: { to: string; bcc: string[] },
): Promise<{ account: EmailProviderAccount | null; reason: string | null }> {
  const limits = (blast.accountLimits && typeof blast.accountLimits === 'object' ? blast.accountLimits : {}) as Record<string, number>;
  const account = await prisma.emailProviderAccount.findUnique({ where: { id } });
  if (!account || account.status !== 'CONNECTED' || !account.refreshTokenEnc) return { account: null, reason: `${account?.emailAddress ?? 'a mailbox'} is disconnected` };
  if (!ctx.allowed.has(id)) return { account: null, reason: `${account.emailAddress} is no longer shared as a backup mailbox` };
  const cap = Number(limits[id]);
  if (Number.isFinite(cap) && cap > 0 && (ctx.used.get(id) ?? 0) + size > cap) return { account: null, reason: `${account.emailAddress} reached the limit you set (${cap})` };
  if ((await backoffUntil(id)) > 0) return { account: null, reason: `${account.emailAddress} is paused by Gmail for a while` };
  const usage = await usageLast24h(id);
  const to = exact?.to ?? 'next-recruiter@planning.invalid';
  const bcc = exact?.bcc ?? Array.from({ length: Math.max(0, size - 1) }, (_, i) => `recruiter-${i}@planning.invalid`);
  if (wouldExceedDaily(usage, { toEmail: to, ccEmails: blast.ccAddresses ?? [], bccEmails: bcc })) return { account: null, reason: `${account.emailAddress} has reached its daily limit` };
  return { account, reason: null };
}

/**
 * One mailbox after another (SEQUENTIAL sends): the first chosen mailbox that can send this
 * message, or every reason none can.
 */
async function chooseMailbox(blast: { id: string; organizationId: string; createdById: string; accountIds: string[]; accountLimits: unknown; ccAddresses?: string[] }, to: string, bcc: string[]) {
  const reasons: string[] = [];
  const [used, allowed] = await Promise.all([sentPerAccount(blast.id), allowedMailboxIds(blast.organizationId, blast.createdById)]);
  for (const id of blast.accountIds) {
    const r = await checkMailbox(blast, id, bcc.length || 1, { used, allowed }, { to, bcc });
    if (r.account) return { account: r.account, reasons };
    reasons.push(r.reason!);
  }
  return { account: null, reasons };
}

/** Sends one message; replaceable in tests so no real email goes out. */
export type RecruiterSender = (account: EmailProviderAccount, input: SendEmailInput, large: boolean) => Promise<{ providerMessageId: string; threadId?: string | null; messageIdHeader?: string | null }>;
const gmailSender: RecruiterSender = (account, input, large) => (large ? sendViaUpload(account, input) : new GmailProvider(account).sendEmail(input));

type BlastRow = Awaited<ReturnType<typeof prisma.recruiterBlast.findMany>>[number];
type GroupRow = { id: string; seq: number; attempts: number; recipientCount: number; plannedAccountId: string | null };
type Person = { id: string; email: string; name: string | null; data: Prisma.JsonValue };
type Outcome = 'sent' | 'failed' | 'retry';

/** At most this many Gmail messages are out at once in one run (a run has under 60 s). */
export const MAX_PARALLEL = 10;

/**
 * Who in this message still gets it: anyone unsubscribed or bounced since the send started
 * (a long send runs for days) is dropped. A message left with nobody is closed.
 */
async function liveRecipients(blast: BlastRow, groupId: string): Promise<Person[]> {
  let recipients = await prisma.recruiterBlastRecipient.findMany({ where: { groupId, status: { in: ['PENDING', 'QUEUED'] } }, select: { id: true, email: true, name: true, data: true } });
  if (recipients.length) {
    const suppressed = await prisma.emailSuppression.findMany({ where: { workspaceId: blast.workspaceId, email: { in: recipients.map((r) => r.email) } }, select: { email: true } });
    if (suppressed.length) {
      const gone = new Set(suppressed.map((s) => s.email.toLowerCase()));
      const drop = recipients.filter((r) => gone.has(r.email.toLowerCase()));
      await prisma.recruiterBlastRecipient.updateMany({ where: { id: { in: drop.map((r) => r.id) } }, data: { status: 'SKIPPED', skipReason: 'Unsubscribed or bounced after the send started' } });
      recipients = recipients.filter((r) => !gone.has(r.email.toLowerCase()));
    }
  }
  if (!recipients.length) await prisma.recruiterBlastGroup.updateMany({ where: { id: groupId, status: 'PENDING' }, data: { status: 'SENT', recipientCount: 0 } });
  return recipients;
}

/**
 * Claims a message for one run (PENDING → SENDING) so it can't be sent twice. SEQUENTIAL: only
 * one message of the send is out at a time. PARALLEL: one per mailbox (so a mailbox can't skip
 * its pause). sentAt = claim time keeps recoverStuck off fresh claims; the old error is cleared
 * so it can't hold the mailbox (backoffUntil).
 */
async function claim(blast: BlastRow, groupId: string, account: EmailProviderAccount, perMailbox: boolean, scope: RunScope): Promise<boolean> {
  const busy = perMailbox ? { none: { status: 'SENDING', accountId: account.id } } : { none: { status: 'SENDING' } };
  // Only while the send still runs where this run sends from: once the cloud has taken over a
  // laptop send (or the other way round), the other side can't claim another message of it.
  const claimed = await prisma.recruiterBlastGroup.updateMany({
    where: { id: groupId, status: 'PENDING', blast: { status: 'SENDING', ...runOnWhere(scope), groups: busy } },
    data: { status: 'SENDING', sentAt: new Date(), accountId: account.id, fromEmail: account.emailAddress, attempts: { increment: 1 }, errorCode: null, error: null },
  });
  return claimed.count > 0;
}

/** Sends one claimed message from `account` and records what happened. */
async function deliver(blast: BlastRow, group: { id: string; attempts: number }, recipients: Person[], account: EmailProviderAccount, send: RecruiterSender): Promise<Outcome> {
  const mode = blast.mode as BlastMode;
  const to = mode === 'BCC' ? blast.toAddress! : recipients[0]!.email;
  const bcc = mode === 'BCC' ? recipients.map((r) => r.email) : [];
  // Individual copies carry the recruiter's own {{Column}} values (name, company, UTM link).
  const content = mode === 'INDIVIDUAL' ? personalize({ subject: blast.subject, html: blast.html, plainText: blast.plainText }, recipients[0]!) : { subject: blast.subject, html: blast.html, plainText: blast.plainText };
  const decorated = decorate(content.html, { groupId: group.id, mode, workspaceId: blast.workspaceId, blastId: blast.id, recipientEmail: mode === 'INDIVIDUAL' ? to : undefined, pixel: mode === 'INDIVIDUAL', sendingAddress: account.emailAddress });
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
      plainText: `${content.plainText}\n\nUnsubscribe: ${decorated.unsubscribeUrl}${mode === 'BCC' ? ` (or email ${account.emailAddress} with the subject "Unsubscribe")` : ''}`,
      // Gmail's own Unsubscribe button: one-click where the link names the person (individual
      // copies); a BCC email's link can't, so it unsubscribes by email (the mailto says who).
      listUnsubscribeUrl: decorated.unsubscribeUrl,
      listUnsubscribeOneClick: mode === 'INDIVIDUAL',
      listUnsubscribeMailto: decorated.unsubscribeMailto,
      attachments,
    };
    // Big messages (a video) go through Gmail's upload endpoint, which takes up to 35 MB.
    const bytes = attachments.reduce((n, a) => n + a.content.length, 0);
    result = await send(account, input, bytes > UPLOAD_THRESHOLD_BYTES);
  } catch (err) {
    const failedForGood = await recordFailure(blast.id, group, account.id, err);
    // Gmail refused the recruiter's address itself (individual copies name one person): it
    // goes on the suppression list everywhere, with the reason, and shows "bounced" here.
    if (mode === 'INDIVIDUAL' && err instanceof SendEmailError && err.kind === 'INVALID_RECIPIENT') {
      const detail = `Gmail rejected the address when sending (Recruiter Bulk Send “${blast.name}”): ${err.message}`;
      await suppressRejectedRecruiter(blast.workspaceId, to, detail).catch((e) => console.error('[recruiter-send] suppress failed', e));
      await markRecruiterBounced(blast.id, [to], detail).catch(() => undefined);
    }
    return failedForGood ? 'failed' : 'retry';
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
  return 'sent';
}

/**
 * The batches every mailbox should send now (PARALLEL sends): each mailbox's next planned
 * batch, once its own pause since its last email has passed and nothing of its is still going
 * out. A mailbox that can't send (disconnected, withdrawn, paused by Gmail, at a limit) hands
 * its batches to the mailboxes that can, fewest-left first, so nothing waits on it.
 */
export async function planRound(blast: BlastRow, now = Date.now()): Promise<{ ready: { group: GroupRow; accountId: string }[]; nextGap: number; waiting: string | null }> {
  const pending = await prisma.recruiterBlastGroup.findMany({
    where: { blastId: blast.id, status: 'PENDING' },
    orderBy: { seq: 'asc' },
    take: 5000,
    select: { id: true, seq: true, attempts: true, recipientCount: true, plannedAccountId: true },
  });
  if (!pending.length) return { ready: [], nextGap: Infinity, waiting: null };
  const [used, allowed, lastSent, busyRows] = await Promise.all([
    sentPerAccount(blast.id),
    allowedMailboxIds(blast.organizationId, blast.createdById),
    prisma.recruiterBlastGroup.groupBy({ by: ['accountId'], where: { blastId: blast.id, status: { in: ['SENT', 'SENDING'] }, sentAt: { not: null } }, _max: { sentAt: true } }),
    prisma.recruiterBlastGroup.findMany({ where: { blastId: blast.id, status: 'SENDING' }, select: { accountId: true } }),
  ]);
  const last = new Map(lastSent.filter((r) => r.accountId).map((r) => [r.accountId!, r._max.sentAt?.getTime() ?? 0]));
  const busy = new Set(busyRows.map((r) => r.accountId).filter(Boolean) as string[]);

  // Which mailboxes can send at all right now.
  const usable: string[] = [];
  const reasons: string[] = [];
  for (const id of blast.accountIds) {
    const size = pending.find((g) => g.plannedAccountId === id)?.recipientCount ?? pending[0]!.recipientCount;
    const r = await checkMailbox(blast, id, size, { used, allowed });
    if (r.account) usable.push(id);
    else reasons.push(r.reason!);
  }
  if (!usable.length) return { ready: [], nextGap: Infinity, waiting: `Waiting: ${reasons.join('; ') || 'no sending mailbox chosen'}. Sending carries on by itself when one is free.` };

  // Batches planned for a mailbox that can't send (or for none) move to ones that can.
  const left = new Map(usable.map((id) => [id, pending.filter((g) => g.plannedAccountId === id).length]));
  const moves = new Map<string, string[]>();
  for (const g of pending) {
    if (g.plannedAccountId && left.has(g.plannedAccountId)) continue;
    const target = usable.reduce((best, id) => (left.get(id)! < left.get(best)! ? id : best), usable[0]!);
    left.set(target, left.get(target)! + 1);
    moves.set(target, [...(moves.get(target) ?? []), g.id]);
    g.plannedAccountId = target;
  }
  for (const [target, ids] of moves) {
    await prisma.recruiterBlastGroup.updateMany({ where: { id: { in: ids }, status: 'PENDING' }, data: { plannedAccountId: target } });
  }
  if (moves.size) console.log(`[recruiter-send] ${blast.id}: moved ${[...moves.values()].flat().length} batch(es) to mailboxes that can send (${reasons.join('; ')})`);

  // Each usable mailbox's next batch, once its own pause is over.
  const ready: { group: GroupRow; accountId: string }[] = [];
  let nextGap = Infinity;
  for (const id of usable) {
    if (busy.has(id)) continue;
    const wait = (last.get(id) ?? 0) + blast.gapSeconds * 1000 - now;
    if (wait > 0) {
      nextGap = Math.min(nextGap, wait);
      continue;
    }
    const group = pending.find((g) => g.plannedAccountId === id);
    if (group) ready.push({ group, accountId: id });
  }
  return { ready, nextGap, waiting: null };
}

/**
 * One sender run. `runOn` picks the sends it handles: 'cloud' (the default on Vercel) skips
 * sends running on the laptop, after moving any whose laptop has gone quiet to the cloud;
 * 'laptop' is the laptop's standby runner (only those, never hands over to Vercel); 'all' is
 * the app running on the laptop as the active server. `stop` ends the run early (between
 * messages; anything already claimed is still sent and recorded).
 */
export async function runRecruiterWorker(opts: { budgetMs?: number; send?: RecruiterSender; staggerMs?: () => number; sleep?: (ms: number) => Promise<unknown>; runOn?: RunScope; stop?: () => boolean } = {}): Promise<{ sent: number; failed: number; waiting: string | null }> {
  const scope: RunScope = opts.runOn ?? (onLaptopServer() ? 'all' : 'cloud');
  const stopped = () => !!opts.stop?.();
  const send = opts.send ?? gmailSender;
  const pause = opts.sleep ?? sleep; // tests pass their own clock
  // Messages of one round leave a little apart (0.7–1.5 s each), not in the same instant.
  const stagger = opts.staggerMs ?? (() => 700 + Math.random() * 800);
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
  const count = (o: Outcome) => {
    if (o === 'sent') sent++;
    else if (o === 'failed') failed++;
  };
  const setWaiting = async (blast: BlastRow, note: string) => {
    waiting = note;
    waitingIds.add(blast.id);
    if (blast.note !== note) await prisma.recruiterBlast.update({ where: { id: blast.id }, data: { note } });
  };
  if (scope === 'cloud') await takeOverSilentLaptopSends();
  await recoverStuck(scope);

  // Scheduled sends whose time has come.
  await prisma.recruiterBlast.updateMany({ where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() }, ...runOnWhere(scope) }, data: { status: 'SENDING', startedAt: new Date() } });

  while (timeLeft() > 0 && !stopped()) {
    const blasts = await prisma.recruiterBlast.findMany({ where: { status: 'SENDING', ...runOnWhere(scope) }, orderBy: { startedAt: 'asc' }, take: 20 });
    if (!blasts.length) break;
    let progressed = false;
    let nextGap = Infinity; // shortest pause still to run, when everything is between messages
    // PARALLEL: this round's messages, from every send, sent together below.
    const round: { blast: BlastRow; group: GroupRow; account: EmailProviderAccount; recipients: Person[] }[] = [];

    for (const blast of blasts) {
      if (timeLeft() <= 0 || stopped()) break;
      if (await finishIfDone(blast.id)) continue;

      if (blast.sendOrder !== 'SEQUENTIAL') {
        if (round.length >= MAX_PARALLEL) continue;
        const plan = await planRound(blast);
        if (plan.waiting) {
          await setWaiting(blast, plan.waiting);
          continue;
        }
        nextGap = Math.min(nextGap, plan.nextGap);
        for (const { group, accountId } of plan.ready) {
          if (round.length >= MAX_PARALLEL) break;
          const recipients = await liveRecipients(blast, group.id);
          if (!recipients.length) {
            progressed = true;
            continue;
          }
          if (timeLeft() < SEND_RESERVE_MS + (round.length + 1) * 1_500) {
            handOver = true;
            break;
          }
          const account = await prisma.emailProviderAccount.findUnique({ where: { id: accountId } });
          if (!account || !(await claim(blast, group.id, account, true, scope))) continue;
          progressed = true;
          round.push({ blast, group, account, recipients });
        }
        if (handOver) break;
        continue;
      }

      // SEQUENTIAL: one message at a time, with the send's pause between messages.
      const last = await prisma.recruiterBlastGroup.findFirst({ where: { blastId: blast.id, status: { in: ['SENT', 'SENDING'] }, sentAt: { not: null } }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } });
      const wait = last?.sentAt ? last.sentAt.getTime() + blast.gapSeconds * 1000 - Date.now() : 0;
      if (wait > 0) {
        if (wait > timeLeft() - SEND_RESERVE_MS) {
          nextGap = Math.min(nextGap, wait);
          continue;
        }
        await pause(wait);
        if (stopped()) break;
        // Paused or cancelled while we waited?
        const current = await prisma.recruiterBlast.findUnique({ where: { id: blast.id }, select: { status: true } });
        if (current?.status !== 'SENDING') continue;
      }
      const group = await prisma.recruiterBlastGroup.findFirst({ where: { blastId: blast.id, status: 'PENDING' }, orderBy: { seq: 'asc' } });
      if (!group) continue;
      const recipients = await liveRecipients(blast, group.id);
      if (!recipients.length) {
        progressed = true;
        continue;
      }
      const mode = blast.mode as BlastMode;
      const to = mode === 'BCC' ? blast.toAddress! : recipients[0]!.email;
      const { account, reasons } = await chooseMailbox(blast, to, mode === 'BCC' ? recipients.map((r) => r.email) : []);
      if (!account) {
        await setWaiting(blast, `Waiting: ${reasons.join('; ') || 'no sending mailbox chosen'}. Sending carries on by itself when one is free.`);
        continue;
      }
      if (timeLeft() < SEND_RESERVE_MS) {
        handOver = true; // not enough time left to send safely: let the next run do it
        break;
      }
      if (!(await claim(blast, group.id, account, false, scope))) continue;
      progressed = true;
      count(await deliver(blast, group, recipients, account, send));
    }

    // The round: every mailbox's message at once, a moment apart.
    if (round.length) {
      let offset = 0;
      const outcomes = await Promise.all(
        round.map((m, i) => {
          if (i > 0) offset += stagger();
          const delay = offset;
          return pause(delay).then(() => deliver(m.blast, m.group, m.recipients, m.account, send));
        }),
      );
      outcomes.forEach(count);
    }

    if (handOver) break;
    if (!progressed) {
      // Everything is between messages: wait here rather than hand over to a new run that
      // would only find the same pause, but keep enough time to send and hand over.
      const usable = timeLeft() - SEND_RESERVE_MS;
      if (Number.isFinite(nextGap) && usable > 1_000 && !stopped()) {
        await pause(Math.min(nextGap, usable));
        continue;
      }
      break;
    }
  }

  // Hand over while any send can still move; sends waiting for a mailbox resume on the schedule.
  // The laptop's runner never hands over to Vercel: it simply runs again (that is the point).
  if (scope === 'laptop' || stopped()) return { sent, failed, waiting };
  const more = await prisma.recruiterBlast.count({ where: { status: 'SENDING', id: { notIn: [...waitingIds] }, ...runOnWhere(scope) } });
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
