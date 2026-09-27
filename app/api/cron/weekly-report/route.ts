import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { cronAuthorised } from '@/lib/cron/auth';
import { dispatchWeeklyReport } from '@/lib/digest/dispatch';

export const maxDuration = 60;

/** Weekly leadership report, Mondays 09:00 IST (vercel.json). */
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  const results = [];
  for (const org of orgs) {
    try {
      results.push(await dispatchWeeklyReport(org.id));
    } catch (err) {
      results.push({ organizationId: org.id, sent: false, reason: `error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return NextResponse.json({ ranAt: new Date(), results });
}
