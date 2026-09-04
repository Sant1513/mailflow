import { prisma } from '@/lib/db/client';
import { processEmailJob, reconcileBatchStatus } from '@/lib/email/processJob';
import type { EmailProvider } from '@/lib/email/provider';
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

export interface DrainOptions {
  limit?: number;
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
    select: { id: true, emailProviderAccountId: true },
  });

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let rateLimited = false;

  // Rate budget is per sending account (§44).
  const budgets = new Map<string, number>();

  for (const job of queued) {
    const accountId = job.emailProviderAccountId;
    if (accountId) {
      if (!budgets.has(accountId)) {
        budgets.set(accountId, await remainingRateBudget(accountId));
      }
      const budget = budgets.get(accountId)!;
      if (budget <= 0) {
        rateLimited = true;
        break; // stop early; the next invocation picks up where we left off
      }
      budgets.set(accountId, budget - 1);
    }

    try {
      const outcome = await processEmailJob(job.id, { providerFactory: opts.providerFactory });
      if (outcome.status === 'SENT') sent += 1;
      else if (outcome.status === 'FAILED') failed += 1;
      else skipped += 1;
    } catch {
      // processEmailJob rethrows retryable errors for BullMQ's benefit; in
      // drain mode the job stays FAILED and is picked up by retry-failed.
      failed += 1;
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
  };
}
