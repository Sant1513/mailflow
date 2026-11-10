import { NextResponse } from 'next/server';
import { cronAuthorised } from '@/lib/cron/auth';
import { nudgeStuckSends } from '@/lib/recruiterSend/worker';

export const dynamic = 'force-dynamic';

/**
 * Cheap watchdog for Recruiter Bulk Send (the laptop calls it every 2 minutes): restarts the
 * sender only when a send has stopped moving, so it costs almost nothing when all is well.
 */
/** Shared header-only, constant-time check (lib/cron/auth.ts). */
const authorised = cronAuthorised;

export async function GET(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const stuck = await nudgeStuckSends('watchdog');
  return NextResponse.json({ ok: true, restarted: stuck });
}
