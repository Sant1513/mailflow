import { google } from 'googleapis';
import { waitUntil } from '@vercel/functions';
import { BatchStatus, CampaignStatus, EmailJobStatus } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { authorizedClientFor } from '@/lib/gmail/oauth';
import { appBaseUrl } from '@/lib/app-url';
import { drainBatch, msUntilRateBudget } from '@/lib/queue/drain';
import { reconcileBatchStatus } from '@/lib/email/processJob';

/**
 * Automatic sending without Redis. Campaign emails wait in the database as
 * QUEUED jobs; this worker sends them at the per-mailbox rate limit until
 * every batch is done. It runs:
 *   - right after a send / resume / retry (kickSendWorker), continuing itself
 *     in fresh invocations while work remains, so the tab can be closed;
 *   - from an open campaign page (each "Process queue" pass);
 *   - from GitHub Actions every 15 minutes as a backstop.
 * Any number of these may run at once: each job is claimed before sending and
 * the rate limit is recounted before every send (lib/queue/drain.ts).
 */

const STUCK_AFTER_MS = 5 * 60_000;

/**
 * Jobs left SENDING by an interrupted request. Before re-queuing, the sender's
 * Gmail "Sent" folder is checked: if the email went out it is marked SENT, so
 * nobody gets it twice; only an email that never left is sent again.
 */
export async function recoverStuckJobs(limit = 20): Promise<{ markedSent: number; requeued: number }> {
  const stuck = await prisma.emailJob.findMany({
    where: { status: EmailJobStatus.SENDING, OR: [{ lastAttemptAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) } }, { lastAttemptAt: null }] },
    take: limit,
    include: { emailProviderAccount: true },
  });
  let markedSent = 0;
  let requeued = 0;
  for (const job of stuck) {
    let foundId: string | null = null;
    let threadId: string | null = null;
    let checked = false;
    if (job.emailProviderAccount && job.emailProviderAccount.status === 'CONNECTED') {
      try {
        const auth = await authorizedClientFor(job.emailProviderAccount);
        const gmail = google.gmail({ version: 'v1', auth });
        const after = Math.floor(((job.lastAttemptAt ?? job.createdAt).getTime() - 120_000) / 1000);
        const subject = job.subject.replace(/"/g, '').slice(0, 120);
        const res = await gmail.users.messages.list({ userId: 'me', q: `in:sent to:${job.toEmail} after:${after} subject:"${subject}"`, maxResults: 1 });
        foundId = res.data.messages?.[0]?.id ?? null;
        threadId = res.data.messages?.[0]?.threadId ?? null;
        checked = true;
      } catch (err) {
        console.error('[send-worker] could not check Gmail for a stuck job', { jobId: job.id, err: (err as Error).message });
      }
    }
    if (foundId) {
      await prisma.emailJob.updateMany({
        where: { id: job.id, status: EmailJobStatus.SENDING },
        data: { status: EmailJobStatus.SENT, gmailMessageId: foundId, gmailThreadId: threadId, sentAt: job.lastAttemptAt ?? new Date() },
      });
      markedSent++;
    } else if (checked) {
      await prisma.emailJob.updateMany({ where: { id: job.id, status: EmailJobStatus.SENDING }, data: { status: EmailJobStatus.QUEUED } });
      requeued++;
    } else {
      // Gmail couldn't be checked (mailbox disconnected): fail it visibly rather than risk a duplicate.
      await prisma.emailJob.updateMany({
        where: { id: job.id, status: EmailJobStatus.SENDING },
        data: { status: EmailJobStatus.FAILED, errorCode: 'INTERRUPTED', errorMessage: 'Sending was interrupted and the mailbox could not be checked. Use "Retry failed" once the mailbox is connected.' },
      });
    }
  }
  return { markedSent, requeued };
}

/** Batches with emails waiting, excluding paused / cancelled and campaigns scheduled for later. */
async function activeBatches(onlyBatchId?: string) {
  const now = new Date();
  const batches = await prisma.batch.findMany({
    where: {
      ...(onlyBatchId ? { id: onlyBatchId } : {}),
      status: { in: [BatchStatus.PREPARING, BatchStatus.QUEUED, BatchStatus.RUNNING] },
      jobs: { some: { status: EmailJobStatus.QUEUED } },
    },
    select: { id: true, campaignId: true, campaign: { select: { status: true, scheduledAt: true } } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  const due = [];
  for (const b of batches) {
    const c = b.campaign;
    if (c.status === CampaignStatus.CANCELLED || c.status === CampaignStatus.PAUSED) continue;
    if (c.status === CampaignStatus.SCHEDULED) {
      if (c.scheduledAt && c.scheduledAt > now) continue;
      await prisma.campaign.update({ where: { id: b.campaignId }, data: { status: CampaignStatus.RUNNING } });
    }
    due.push(b);
  }
  return due;
}

export interface WorkerResult {
  sent: number;
  failed: number;
  remaining: number;
  batches: number;
  recovered: { markedSent: number; requeued: number };
  /** Another sender was already working, so this one stepped aside. */
  busy?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when some sender sent or claimed an email in the last 20 s. */
async function anotherWorkerActive(): Promise<boolean> {
  const since = new Date(Date.now() - 20_000);
  const recent = await prisma.emailJob.findFirst({
    where: { OR: [{ status: EmailJobStatus.SENT, sentAt: { gte: since } }, { status: EmailJobStatus.SENDING, lastAttemptAt: { gte: since } }] },
    select: { id: true },
  });
  return !!recent;
}

async function queuedCount(batchId?: string) {
  return prisma.emailJob.count({
    where: {
      status: EmailJobStatus.QUEUED,
      ...(batchId ? { batchId } : {}),
      batch: { status: { in: [BatchStatus.PREPARING, BatchStatus.QUEUED, BatchStatus.RUNNING] } },
    },
  });
}

/**
 * Sends for up to `budgetMs`, emails 3 s apart and within the per-minute limit.
 * Only one sender works at a time: unless this is the running sender's own
 * continuation, it steps aside when another sent in the last 20 s, which keeps
 * the spacing exact. Stops starting new sends before the budget ends.
 */
export async function runSendWorker(opts: { budgetMs?: number; batchId?: string; continuation?: boolean } = {}): Promise<WorkerResult> {
  if (!opts.continuation && (await anotherWorkerActive())) {
    return { sent: 0, failed: 0, remaining: await queuedCount(opts.batchId), batches: 0, recovered: { markedSent: 0, requeued: 0 }, busy: true };
  }
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);
  const recovered = await recoverStuckJobs();
  let sent = 0;
  let failed = 0;
  let batches = await activeBatches(opts.batchId);
  const batchCount = batches.length;

  while (batches.length && Date.now() < deadline) {
    let progressed = false;
    let rateLimitedAccounts: string[] = [];
    for (const b of batches) {
      if (Date.now() >= deadline) break;
      const r = await drainBatch(b.id, { limit: 25, deadline });
      sent += r.sent;
      failed += r.failed;
      if (r.processed > 0) progressed = true;
      if (r.rateLimited) {
        const acc = await prisma.emailJob.findFirst({ where: { batchId: b.id, status: EmailJobStatus.QUEUED }, select: { emailProviderAccountId: true } });
        if (acc?.emailProviderAccountId) rateLimitedAccounts.push(acc.emailProviderAccountId);
      }
    }
    batches = await activeBatches(opts.batchId);
    if (!batches.length) break;
    if (!progressed) {
      // Everything is waiting on the per-minute limit: sleep until a slot frees up.
      rateLimitedAccounts = [...new Set(rateLimitedAccounts)];
      const waits = await Promise.all(rateLimitedAccounts.map((a) => msUntilRateBudget(a)));
      const wait = Math.min(...(waits.length ? waits : [5_000]), 15_000);
      if (Date.now() + wait >= deadline - 2_000) break;
      await sleep(Math.max(wait, 1_000));
    }
  }

  const remaining = await queuedCount(opts.batchId);
  // Batches that just ran dry get their final status.
  const settled = await prisma.batch.findMany({
    where: { status: { in: [BatchStatus.PREPARING, BatchStatus.QUEUED, BatchStatus.RUNNING] }, jobs: { none: { status: { in: [EmailJobStatus.QUEUED, EmailJobStatus.SENDING] } } } },
    select: { id: true },
    take: 50,
  });
  for (const b of settled) await reconcileBatchStatus(b.id).catch(() => undefined);

  return { sent, failed, remaining, batches: batchCount, recovered };
}

/**
 * Starts (or continues) the worker in a fresh serverless invocation without
 * making the caller wait: the request is fired and the response not awaited.
 */
export function kickSendWorker(reason: string, opts: { continuation?: boolean } = {}): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  const controller = new AbortController();
  const chain = opts.continuation ? '&chain=1' : '';
  const call = fetch(`${appBaseUrl()}/api/cron/send-queue?reason=${encodeURIComponent(reason)}${chain}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: controller.signal,
  }).catch(() => undefined);
  // The next invocation only needs to start; it keeps running after we hang up.
  const hangUp = new Promise<void>((resolve) => setTimeout(() => { controller.abort(); resolve(); }, 2_500));
  try {
    waitUntil(Promise.race([call, hangUp]));
  } catch {
    void call;
  }
}
