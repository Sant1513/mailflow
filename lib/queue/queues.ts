import { Queue, type JobsOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';

/**
 * §40 Queue architecture.
 *
 *   Campaign → Batch → EmailJob rows → queue → worker → Gmail → history
 *
 * Redis/BullMQ is the production path (`npm run worker:email`). It is
 * OPTIONAL at runtime: when REDIS_URL is unset — as on a plain Vercel
 * deployment with no Redis attached — `getQueue()` returns null and callers
 * fall back to the bounded drain endpoint (see lib/queue/drain.ts). Both
 * paths run the identical per-job processor, so behaviour does not diverge.
 */

export const QUEUE_NAMES = {
  EMAIL_SEND: 'email-send',
  GMAIL_SYNC: 'gmail-sync',
  AUTOMATION_EVAL: 'automation-eval',
} as const;

export interface EmailJobPayload {
  emailJobId: string;
  batchId: string;
}

export interface AutomationEvalPayload {
  automationId: string;
  automationVersionId: string;
  recordId: string;
  triggerType: string;
}

let connection: Redis | null = null;
const queues = new Map<string, Queue>();

export function redisAvailable(): boolean {
  return !!process.env.REDIS_URL;
}

function getConnection(): Redis | null {
  if (!redisAvailable()) return null;
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL!, {
      // Required by BullMQ: it manages its own retry semantics.
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    connection.on('error', (err) => console.error('[queue] redis error', err.message));
  }
  return connection;
}

export function getQueue(name: string): Queue | null {
  const conn = getConnection();
  if (!conn) return null;
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: conn });
    queues.set(name, queue);
  }
  return queue;
}

/** Default retry policy — §42: 1m, 5m, 15m-ish with exponential backoff. */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: Number(process.env.EMAIL_MAX_ATTEMPTS ?? 4),
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: false,
};

export async function enqueueEmailJobs(payloads: EmailJobPayload[]): Promise<{ enqueued: number; queued: boolean }> {
  const queue = getQueue(QUEUE_NAMES.EMAIL_SEND);
  if (!queue) return { enqueued: 0, queued: false };

  await queue.addBulk(
    payloads.map((payload) => ({
      name: 'send',
      data: payload,
      opts: {
        ...DEFAULT_JOB_OPTIONS,
        // The EmailJob row id is the idempotency key (§40/§41): re-adding
        // the same job id is a no-op in BullMQ, so a double-click or a
        // retried HTTP request cannot enqueue a duplicate send.
        jobId: payload.emailJobId,
      },
    }))
  );

  return { enqueued: payloads.length, queued: true };
}

export async function closeQueues(): Promise<void> {
  for (const queue of queues.values()) await queue.close();
  queues.clear();
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
