import { NextResponse } from 'next/server';
import { runRecruiterWorker } from '@/lib/recruiterSend/worker';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * Recruiter Bulk Send sender (lib/recruiterSend/worker.ts). Started by every send, resume and
 * by itself while work remains; every 15 minutes by GitHub Actions / the laptop as a backstop.
 */
function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  return (req.headers.get('authorization') ?? '') === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const result = await runRecruiterWorker({ budgetMs: 45_000 });
  return NextResponse.json({ ok: true, ...result });
}
