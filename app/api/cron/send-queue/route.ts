import { NextResponse } from 'next/server';
import { BatchStatus, EmailJobStatus } from '@prisma/client';
import { prisma } from '@/lib/db/client';
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
  try {
    const result = await runSendWorker({ budgetMs: 45_000, continuation });
    // The active sender hands over to a fresh invocation; one that stepped aside does nothing.
    // A mailbox on hold (daily limit / Gmail back-off) is picked up again by the 15-minute backstop.
    if (!result.busy && !result.held && result.remaining > 0) kickSendWorker('continue', { continuation: true });
    return NextResponse.json(result);
  } catch (err) {
    // Even if this run crashed, hand over so sending doesn't stop until the next backstop.
    console.error('[send-queue] run failed', (err as Error).message);
    const remaining = await prisma.emailJob
      .count({ where: { status: EmailJobStatus.QUEUED, batch: { status: { in: [BatchStatus.PREPARING, BatchStatus.QUEUED, BatchStatus.RUNNING] } } } })
      .catch(() => 0);
    if (remaining > 0) kickSendWorker('continue-after-error', { continuation: true });
    return NextResponse.json({ error: 'Send run failed; continuing.', remaining }, { status: 500 });
  }
}
