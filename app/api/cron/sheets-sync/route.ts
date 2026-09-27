import { NextResponse } from 'next/server';
import { cronAuthorised } from '@/lib/cron/auth';
import { syncAllSheets } from '@/lib/sheets/sync';

export const maxDuration = 60;

/** Every 15 minutes (GitHub Actions) plus a daily Vercel backstop: sync every connected Google Sheet. */
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json(await syncAllSheets());
}
