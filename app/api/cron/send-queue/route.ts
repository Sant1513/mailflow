import { NextResponse } from 'next/server';
import { cronAuthorised } from '@/lib/cron/auth';
import { kickSendWorker, runSendWorker } from '@/lib/queue/sendWorker';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * Sends queued campaign emails for ~45 s, then, if any are left, starts a
 * fresh invocation of itself to carry on. Started by a send / resume / retry,
 * and by GitHub Actions every 15 minutes as a backstop.
 */
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const continuation = new URL(req.url).searchParams.get('chain') === '1';
  const result = await runSendWorker({ budgetMs: 45_000, continuation });
  // The active sender hands over to a fresh invocation; one that stepped aside does nothing.
  if (!result.busy && result.remaining > 0) kickSendWorker('continue', { continuation: true });
  return NextResponse.json(result);
}
