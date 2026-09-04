/**
 * §40 email-send worker. Run as its own process:
 *
 *   npm run worker:email
 *
 * Requires REDIS_URL. This is the production send path; the drain endpoint
 * (lib/queue/drain.ts) is the fallback for deployments without a persistent
 * worker. Both call processEmailJob, so behaviour is identical.
 */
import 'dotenv/config';
import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE_NAMES, type EmailJobPayload } from '../lib/queue/queues';
import { processEmailJob, reconcileBatchStatus } from '../lib/email/processJob';
import { remainingRateBudget } from '../lib/queue/drain';
import { prisma } from '../lib/db/client';

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error('REDIS_URL is not set. The email worker requires Redis.');
  console.error('Either set REDIS_URL, or drive sending via POST /api/batches/:id/drain instead.');
  process.exit(1);
}

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
const ratePerMinute = Number(process.env.EMAIL_RATE_LIMIT_PER_MINUTE ?? 20);

const worker = new Worker<EmailJobPayload>(
  QUEUE_NAMES.EMAIL_SEND,
  async (job: Job<EmailJobPayload>) => {
    const { emailJobId, batchId } = job.data;

    // Belt-and-braces rate check. BullMQ's limiter caps throughput for this
    // worker; this also holds when several workers share one Gmail account.
    const row = await prisma.emailJob.findUnique({
      where: { id: emailJobId },
      select: { emailProviderAccountId: true },
    });
    if (row?.emailProviderAccountId) {
      const budget = await remainingRateBudget(row.emailProviderAccountId);
      if (budget <= 0) {
        // Re-queue with a delay rather than burning an attempt.
        await job.moveToDelayed(Date.now() + 30_000, job.token);
        return { deferred: true };
      }
    }

    const outcome = await processEmailJob(emailJobId);
    await reconcileBatchStatus(batchId);
    return outcome;
  },
  {
    connection,
    concurrency: Number(process.env.EMAIL_WORKER_CONCURRENCY ?? 5),
    limiter: { max: ratePerMinute, duration: 60_000 },
  }
);

worker.on('completed', (job) => {
  console.log('[email-worker] completed', job.id);
});

worker.on('failed', (job, err) => {
  console.error('[email-worker] failed', job?.id, err.message, `(attempt ${job?.attemptsMade})`);
});

console.log(`[email-worker] listening on "${QUEUE_NAMES.EMAIL_SEND}" at ${ratePerMinute}/min`);

async function shutdown(signal: string) {
  console.log(`[email-worker] ${signal} received, finishing in-flight jobs…`);
  await worker.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
