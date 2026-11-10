import { NextResponse } from 'next/server';
import { cronAuthorised } from '@/lib/cron/auth';
import { runDailyHousekeeping } from '@/lib/retention/housekeeping';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * Daily housekeeping, 2 AM IST (Vercel cron + the laptop when it is the server): deletes old
 * notifications, audit entries, webhook deliveries and expired sessions, and warns super admins
 * before a free-plan limit is near. Safe to run more than once a day. See lib/retention/housekeeping.ts.
 */
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json(await runDailyHousekeeping());
}
