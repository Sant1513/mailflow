import { NextResponse } from 'next/server';
import { nudgeStuckSends } from '@/lib/recruiterSend/worker';

export const dynamic = 'force-dynamic';

/**
 * Cheap watchdog for Recruiter Bulk Send (the laptop calls it every 2 minutes): restarts the
 * sender only when a send has stopped moving, so it costs almost nothing when all is well.
 */
function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  return (req.headers.get('authorization') ?? '') === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const stuck = await nudgeStuckSends('watchdog');
  return NextResponse.json({ ok: true, restarted: stuck });
}
