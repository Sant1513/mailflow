import { NextResponse } from 'next/server';
import { currentState } from '@/lib/system/serverState';

// Read by the front door (middleware.ts) to decide where requests go. Always answered by the
// cloud deployment itself (the middleware never forwards this path), and only to callers that
// know CRON_SECRET, because the answer includes the laptop's public address.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('x-mailflow-internal') !== secret) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const s = await currentState();
  return NextResponse.json(
    { activeServer: s.activeServer, switching: s.switchTo, laptopUrl: s.laptopUrl },
    { headers: { 'cache-control': 'no-store' } },
  );
}
