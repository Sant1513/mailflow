import { NextResponse } from 'next/server';
import { cronAuthorised } from '@/lib/cron/auth';
import { runBounceScan } from '@/lib/email/bounceScan';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * Searches every connected mailbox for delivery-failure notices and suppresses the addresses (lib/email/bounceScan.ts).
 * Called every 15 minutes by the scheduled-jobs workflow. `?mailbox=a@b.com` scans just that mailbox (for checking one).
 * Safe to call as often as you like: each mailbox remembers how far it has read.
 */
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const only = new URL(req.url).searchParams.get('mailbox') ?? undefined;
  const startedAt = new Date();
  const summary = await runBounceScan({ budgetMs: 50_000, onlyMailbox: only });
  return NextResponse.json({ startedAt, finishedAt: new Date(), ...summary });
}
