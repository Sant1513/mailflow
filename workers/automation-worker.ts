/**
 * automation-eval worker. Run as its own process:
 *
 *   npm run worker:automation
 *
 * Requires REDIS_URL. Processes delayed automation continuations queued when
 * a WAIT step is reached — i.e. fires the remaining actions after the wait
 * duration has elapsed.
 */
import 'dotenv/config';
import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE_NAMES, type AutomationEvalPayload } from '../lib/queue/queues';
import { evaluateAutomationForRecord } from '../lib/automation/runner';

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error('REDIS_URL is not set. The automation worker requires Redis.');
  console.error('Set REDIS_URL, or WAIT steps will be skipped on this deployment.');
  process.exit(1);
}

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });

const worker = new Worker<AutomationEvalPayload>(
  QUEUE_NAMES.AUTOMATION_EVAL,
  async (job: Job<AutomationEvalPayload>) => {
    const { automationId, recordId, triggerType, startFromActionIndex } = job.data;
    const result = await evaluateAutomationForRecord({
      automationId,
      recordId,
      triggerType,
      startFromActionIndex: startFromActionIndex ?? 0,
      performActions: true,
    });
    return result;
  },
  { connection, concurrency: 10 }
);

worker.on('completed', (job) => {
  console.log('[automation-worker] completed', { jobId: job.id, result: job.returnvalue?.result });
});
worker.on('failed', (job, err) => {
  console.error('[automation-worker] failed', { jobId: job?.id, error: err.message });
});

console.log('[automation-worker] started, listening on queue:', QUEUE_NAMES.AUTOMATION_EVAL);
