import { NextResponse } from 'next/server';
import { cronAuthorised } from '@/lib/cron/auth';
import { runRecruiterWorker } from '@/lib/recruiterSend/worker';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * Recruiter Bulk Send sender (lib/recruiterSend/worker.ts). Started by every send, resume and
 * by itself while work remains; every 15 minutes by GitHub Actions / the laptop as a backstop.
 */
/** Shared header-only, constant-time check (lib/cron/auth.ts). */
const authorised = cronAuthorised;

export async function GET(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const result = await runRecruiterWorker({ budgetMs: 45_000 });
  return NextResponse.json({ ok: true, ...result });
}
