import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { syncAccountToCompletion } from '@/lib/gmail/sync';

export const maxDuration = 60;

/**
 * §104 scheduled sync for every connected mailbox (every 15 min via GitHub
 * Actions, daily backstop via vercel.json). Same code path as Sync Now, so
 * student replies AND the team's own Gmail replies land in MailFlow without
 * anyone pressing a button. Push delivery (Pub/Sub) remains the faster path
 * when configured.
 */
function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}` || new URL(req.url).searchParams.get('secret') === secret;
}

export async function GET(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const startedAt = new Date();
  const accounts = await prisma.emailProviderAccount.findMany({ where: { status: 'CONNECTED', refreshTokenEnc: { not: null } }, take: 50 });
  const results: { accountId: string; email: string; path?: string; listed?: number; stored?: number; fetched?: number; remaining?: number; elapsedMs?: number; errors: number; error?: string }[] = [];
  const deadline = Date.now() + 50_000;
  for (const account of accounts) {
    const left = deadline - Date.now();
    if (left < 5_000) {
      results.push({ accountId: account.id, email: account.emailAddress, errors: 0, error: 'Skipped: out of time this run; next run picks it up.' });
      continue;
    }
    try {
      const r = await syncAccountToCompletion(account, { totalBudgetMs: Math.min(45_000, Math.floor(left / Math.max(1, accounts.length - results.length))) });
      results.push({ accountId: account.id, email: account.emailAddress, path: r.path, listed: r.listed, stored: r.stored, fetched: r.fetched, remaining: r.remaining, elapsedMs: r.elapsedMs, errors: r.errors.length });
    } catch (err) {
      results.push({ accountId: account.id, email: account.emailAddress, errors: 1, error: ((err as Error).message ?? 'unknown').slice(0, 200) });
    }
  }
  return NextResponse.json({ startedAt, finishedAt: new Date(), accounts: accounts.length, results });
}
