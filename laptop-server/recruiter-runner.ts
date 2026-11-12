/**
 * "Send from the laptop" for Recruiter Bulk Send (runOn = 'laptop'): sends those sends' emails
 * from this laptop while it is on STANDBY, so they cost no Vercel CPU. Not a server switch:
 * MailFlow itself stays on the cloud, and this works straight on the CLOUD database with the
 * app's own sender (lib/recruiterSend/worker.ts: the same claims, pauses, limits and Gmail code).
 *
 * Started and stopped by start.mjs (a child process, like the app):
 *   node node_modules/tsx/dist/cli.mjs laptop-server/recruiter-runner.ts
 * with DATABASE_URL = the cloud database and the secrets from mailflow-data\app.env
 * (ENCRYPTION_KEY for the mailbox tokens, Google client, SUPABASE_* for a video). When the
 * laptop becomes the active server the app sends everything itself and this runner is stopped.
 *
 * Every ~20 s it runs the sender for laptop sends only. Writing "stop" on stdin (or start.mjs
 * going away, which closes stdin) ends it cleanly: a message already claimed is still sent and
 * recorded, nothing new is started. If the laptop goes silent for 10 minutes, the cloud takes
 * these sends over by itself (takeOverSilentLaptopSends); claims mean no message goes twice.
 */
import { prisma } from '../lib/db/client';
import { runRecruiterWorker } from '../lib/recruiterSend/worker';

const IDLE_MS = 20_000;
/** One run's length; short enough that a stop request is honoured within about a minute. */
const RUN_BUDGET_MS = 60_000;

let stopping = false;
const log = (...parts: unknown[]) => console.log(new Date().toISOString(), '[recruiter-runner]', ...parts);

function requestStop(why: string) {
  if (stopping) return;
  stopping = true;
  log(`stopping (${why}) after the current message…`);
}
process.stdin.on('data', (d) => { if (String(d).includes('stop')) requestStop('asked by the laptop server'); });
process.stdin.on('end', () => requestStop('the laptop server went away'));
process.stdin.on('error', () => requestStop('the laptop server went away'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => requestStop(sig));

/** A wait that ends early when a stop is requested. */
async function idle(ms: number) {
  for (let t = 0; t < ms && !stopping; t += 500) await new Promise((r) => setTimeout(r, 500));
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL (the cloud database) is not set');
  if (!process.env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is not set (mailflow-data\\app.env)');
  log('started: sending Recruiter Bulk Sends marked "Send from the laptop".');
  let quietSince = 0;
  while (!stopping) {
    const started = Date.now();
    try {
      const r = await runRecruiterWorker({ runOn: 'laptop', budgetMs: RUN_BUDGET_MS, stop: () => stopping });
      if (r.sent || r.failed) log(`sent ${r.sent}, failed ${r.failed}${r.waiting ? ` · ${r.waiting}` : ''}`);
      else if (r.waiting && Date.now() - quietSince > 10 * 60_000) {
        quietSince = Date.now();
        log(r.waiting);
      }
    } catch (err) {
      log('run failed (retrying shortly):', err instanceof Error ? err.stack || err.message : String(err));
    }
    // A run that found nothing to do returns at once: wait before looking again. A run that
    // was busy until its budget ran out goes straight on.
    if (Date.now() - started < RUN_BUDGET_MS - 20_000) await idle(IDLE_MS);
  }
  log('stopped.');
}

main()
  .catch((err) => {
    log('could not run:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
    process.exit();
  });
