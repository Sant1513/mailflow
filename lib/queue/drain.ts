import { prisma } from '@/lib/db/client';
import { processEmailJob, reconcileBatchStatus } from '@/lib/email/processJob';
import { SendEmailError, type EmailProvider } from '@/lib/email/provider';
import { fallbackOptIns, holdReasonText, type HoldReason } from '@/lib/campaigns/fallback';
import { EmailJobStatus, BatchStatus } from '@prisma/client';

/**
 * Bounded, serverless-friendly batch processor.
 *
 * The BullMQ worker (workers/email-worker.ts) is the production path. This
 * exists for deployments with no persistent worker — a plain Vercel
 * deployment with no Redis — where something must still move jobs along.
 * It processes at most `limit` jobs per invocation and returns, so it fits
 * inside a serverless function timeout and can be driven by a cron ping.
 *
 * It is NOT a shortcut around §40 ("never send hundreds of emails in one
 * synchronous HTTP request"): the cap and the per-minute rate limit are
 * enforced here, and it shares processEmailJob with the real worker.
 */

export const DEFAULT_DRAIN_LIMIT = 25;

export interface DrainResult {
  batchId: string;
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
  remaining: number;
  batchStatus: BatchStatus;
  rateLimited: boolean;
  /** Sending from this mailbox is on hold: Google's daily limit is near, or Gmail asked us to back off. */
  heldReason?: 'daily_limit' | 'backoff' | 'disconnected';
}

function ratePerMinute(): number {
  const configured = Number(process.env.EMAIL_RATE_LIMIT_PER_MINUTE ?? 20);
  return Number.isFinite(configured) && configured > 0 ? configured : 20;
}

/**
 * §44: counts sends already made in the trailing minute for this sender and
 * returns how many more are allowed right now. Uses the durable EmailJob
 * rows rather than in-memory counters, so the limit holds across serverless
 * invocations and worker restarts.
 */
export async function remainingRateBudget(emailProviderAccountId: string): Promise<number> {
  const since = new Date(Date.now() - 60_000);
  const recentSends = await prisma.emailJob.count({
    where: { emailProviderAccountId, status: EmailJobStatus.SENT, sentAt: { gte: since } },
  });
  return Math.max(0, ratePerMinute() - recentSends);
}

/** Minimum gap between two emails from the same mailbox (EMAIL_SEND_GAP_MS, default 3 s). */
export function sendGapMs(): number {
  const configured = Number(process.env.EMAIL_SEND_GAP_MS ?? 3000);
  return Number.isFinite(configured) && configured >= 0 ? Math.min(configured, 60_000) : 3000;
}

/** How long to wait so this mailbox's next email goes out at least sendGapMs() after its last one. */
export async function msUntilNextSendSlot(emailProviderAccountId: string): Promise<number> {
  const gap = sendGapMs();
  if (!gap) return 0;
  const last = await prisma.emailJob.findFirst({
    where: { emailProviderAccountId, status: EmailJobStatus.SENT, sentAt: { gte: new Date(Date.now() - gap) } },
    orderBy: { sentAt: 'desc' },
    select: { sentAt: true },
  });
  return last?.sentAt ? Math.max(0, last.sentAt.getTime() + gap - Date.now()) : 0;
}

/** When the per-minute budget frees up again: a minute after the oldest send in the window. */
export async function msUntilRateBudget(emailProviderAccountId: string): Promise<number> {
  const since = new Date(Date.now() - 60_000);
  const oldest = await prisma.emailJob.findFirst({
    where: { emailProviderAccountId, status: EmailJobStatus.SENT, sentAt: { gte: since } },
    orderBy: { sentAt: 'asc' },
    select: { sentAt: true },
  });
  if (!oldest?.sentAt) return 0;
  return Math.max(0, oldest.sentAt.getTime() + 60_000 - Date.now()) + 250;
}

/**
 * Google Workspace lets a user send to 2,000 recipients per rolling 24 hours (500 on trial
 * accounts); going over blocks sending for up to 24 hours. Campaigns stop at
 * EMAIL_DAILY_LIMIT (default 1,500, never above 1,900) so the person's own email still has room.
 */
export function dailyLimit(): number {
  const configured = Number(process.env.EMAIL_DAILY_LIMIT ?? 1500);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 1900) : 1500;
}

const recipientsOf = (j: { ccEmails: string[]; bccEmails: string[] }) => 1 + j.ccEmails.length + j.bccEmails.length;

/** Recipients (To + Cc + Bcc) this mailbox has sent campaign email to in the last 24 hours. */
export async function recipientsSentLast24h(emailProviderAccountId: string): Promise<number> {
  const rows = await prisma.emailJob.findMany({
    where: { emailProviderAccountId, status: EmailJobStatus.SENT, sentAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
    select: { ccEmails: true, bccEmails: true },
  });
  return rows.reduce((n, r) => n + recipientsOf(r), 0);
}

/** After Gmail says "slow down", wait 10 minutes; after a quota error, an hour (Google's guidance). */
export const BACKOFF_MS: Record<string, number> = { RATE_LIMIT: 10 * 60_000, QUOTA: 60 * 60_000 };

/** Epoch ms until which this mailbox should not send because Gmail pushed back recently (0 = free). */
export async function backoffUntil(emailProviderAccountId: string): Promise<number> {
  const last = await prisma.emailJob.findFirst({
    where: { emailProviderAccountId, status: EmailJobStatus.FAILED, errorCode: { in: Object.keys(BACKOFF_MS) }, lastAttemptAt: { gte: new Date(Date.now() - 60 * 60_000) } },
    orderBy: { lastAttemptAt: 'desc' },
    select: { errorCode: true, lastAttemptAt: true },
  });
  if (!last?.lastAttemptAt || !last.errorCode) return 0;
  const until = last.lastAttemptAt.getTime() + (BACKOFF_MS[last.errorCode] ?? 0);
  return until > Date.now() ? until : 0;
}

export interface DrainOptions {
  limit?: number;
  /** Epoch ms after which no new send is started, so a request is never cut off mid-send. */
  deadline?: number;
  /**
   * Overrides the email provider. Exists so this path — which is the real
   * send path on deployments without Redis — can be exercised end-to-end in
   * tests without contacting Gmail.
   */
  providerFactory?: (account: any) => EmailProvider;
}

export async function drainBatch(batchId: string, options: number | DrainOptions = {}): Promise<DrainResult> {
  // Accepts a bare number for convenience: drainBatch(id, 10).
  const opts: DrainOptions = typeof options === 'number' ? { limit: options } : options;
  const limit = opts.limit ?? DEFAULT_DRAIN_LIMIT;
  const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });

  if (batch.status === BatchStatus.PAUSED || batch.status === BatchStatus.CANCELLED) {
    const remaining = await prisma.emailJob.count({
      where: { batchId, status: EmailJobStatus.QUEUED },
    });
    return {
      batchId,
      processed: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      remaining,
      batchStatus: batch.status,
      rateLimited: false,
    };
  }

  await prisma.batch.update({ where: { id: batchId }, data: { status: BatchStatus.RUNNING } });

  const queued = await prisma.emailJob.findMany({
    where: { batchId, status: EmailJobStatus.QUEUED },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, emailProviderAccountId: true, ccEmails: true, bccEmails: true, sendReason: true },
  });

  // Backup mailboxes for this campaign, in order (only owners who opted in; see lib/campaigns/fallback.ts).
  const campaign = await prisma.campaign.findUnique({
    where: { id: batch.campaignId },
    select: { organizationId: true, fromName: true, fallbackAccountIds: true },
  });
  const optIns = campaign?.fallbackAccountIds.length ? await fallbackOptIns(campaign.organizationId) : new Set<string>();
  const fallbackIds = (campaign?.fallbackAccountIds ?? []).filter((id) => optIns.has(id));

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let rateLimited = false;
  let heldReason: DrainResult['heldReason'];
  // Per-mailbox state for this pass: daily recipient count (kept up to date as we send) and the account.
  const dailyUsed = new Map<string, number>();
  const accounts = new Map<string, { id: string; emailAddress: string; displayName: string | null; status: string } | null>();
  const accountOf = async (id: string) => {
    if (!accounts.has(id)) {
      accounts.set(id, await prisma.emailProviderAccount.findUnique({ where: { id }, select: { id: true, emailAddress: true, displayName: true, status: true } }));
    }
    return accounts.get(id)!;
  };
  /** Why this mailbox can't send `need` more recipients right now, or null if it can. */
  const holdOf = async (id: string, need: number): Promise<HoldReason | null> => {
    const account = await accountOf(id);
    if (!account || account.status !== 'CONNECTED') return 'disconnected';
    if ((await backoffUntil(id)) > 0) return 'backoff';
    if (!dailyUsed.has(id)) dailyUsed.set(id, await recipientsSentLast24h(id));
    if (dailyUsed.get(id)! + need > dailyLimit()) return 'daily_limit';
    return null;
  };

  for (const job of queued) {
    if (opts.deadline && Date.now() > opts.deadline) {
      break; // the next pass picks up where this one stopped
    }
    const need = recipientsOf(job);
    let acct = job.emailProviderAccountId;
    let reroute: { id: string; emailAddress: string; displayName: string | null; because: string } | null = null;
    if (acct) {
      const hold = await holdOf(acct, need);
      if (hold) {
        // The campaign's mailbox can't send now: use the first backup mailbox that can.
        for (const fb of fallbackIds) {
          if (fb === acct) continue;
          if (!(await holdOf(fb, need))) {
            const account = (await accountOf(fb))!;
            const main = await accountOf(acct);
            reroute = { ...account, because: `${main?.emailAddress ?? 'the campaign mailbox'} ${holdReasonText(hold)}` };
            break;
          }
        }
        if (!reroute) {
          // No backup available: hold. It resumes on its own (window frees / back-off ends / backup added).
          heldReason = hold;
          break;
        }
        acct = reroute.id;
      }
    }

    // Rate budget is per sending account (§44), counted fresh before every send so several
    // senders working at once (server, open tab, backup cron) still share one limit.
    if (acct && (await remainingRateBudget(acct)) <= 0) {
      rateLimited = true;
      break;
    }
    // Space emails out: at least sendGapMs() (3 s by default) after this mailbox's previous one.
    if (acct) {
      const wait = await msUntilNextSendSlot(acct);
      if (wait > 0) {
        if (opts.deadline && Date.now() + wait > opts.deadline) break;
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    // Claim the job: only one sender can move it from QUEUED to SENDING, so two senders
    // working the same batch never email the same person twice. A rerouted job takes the
    // backup mailbox as its sender (From address; the campaign's From name is kept if set).
    const claimed = await prisma.emailJob.updateMany({
      where: { id: job.id, status: EmailJobStatus.QUEUED },
      data: {
        status: EmailJobStatus.SENDING,
        lastAttemptAt: new Date(),
        ...(reroute
          ? {
              emailProviderAccountId: reroute.id,
              fromEmail: reroute.emailAddress,
              ...(campaign?.fromName?.trim() ? {} : { fromName: reroute.displayName ?? reroute.emailAddress }),
              sendReason: `${job.sendReason ?? ''}\nSent from backup mailbox ${reroute.emailAddress} because ${reroute.because}.`.trim(),
            }
          : {}),
      },
    });
    if (!claimed.count) continue;

    try {
      const outcome = await processEmailJob(job.id, { providerFactory: opts.providerFactory });
      if (outcome.status === 'SENT') {
        sent += 1;
        if (acct) dailyUsed.set(acct, (dailyUsed.get(acct) ?? 0) + need);
      } else if (outcome.status === 'FAILED') failed += 1;
      else {
        skipped += 1;
        // Skipped before anything was sent (e.g. the batch was paused this instant): back in the queue.
        await prisma.emailJob.updateMany({ where: { id: job.id, status: EmailJobStatus.SENDING }, data: { status: EmailJobStatus.QUEUED } });
      }
    } catch (err) {
      // processEmailJob rethrows retryable errors for BullMQ's benefit; in
      // drain mode the job stays FAILED and is picked up by retry-failed.
      // Anything left SENDING after an unexpected error is resolved by
      // recoverStuckJobs, which checks Gmail before re-queuing.
      failed += 1;
      // Gmail pushed back (rate or quota): that mailbox is now on hold (backoffUntil sees this
      // refusal), so the next email goes to a backup mailbox, or the batch holds if there is none.
      // The refused email is re-queued once the back-off has passed.
      if (err instanceof SendEmailError && (err.kind === 'RATE_LIMIT' || err.kind === 'QUOTA')) continue;
    }
  }

  const remaining = await prisma.emailJob.count({ where: { batchId, status: EmailJobStatus.QUEUED } });
  const batchStatus = remaining === 0 ? await reconcileBatchStatus(batchId) : BatchStatus.RUNNING;

  return {
    batchId,
    processed: sent + failed + skipped,
    sent,
    failed,
    skipped,
    remaining,
    batchStatus,
    rateLimited,
    heldReason,
  };
}
