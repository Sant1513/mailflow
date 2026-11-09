import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { cronAuthorised } from '@/lib/cron/auth';
import { dispatchDailyReport } from '@/lib/digest/dispatch';
import { syncOrgBounces } from '@/lib/email/bounces';

export const maxDuration = 60;

/**
 * The daily report, 8 PM IST Monday to Friday (lib/digest/dispatch.ts). Called by the Vercel
 * cron (weekday evenings), the 15-minute dispatch check and the laptop; it sends only when a
 * report is due and hasn't gone out yet, so calling it more than once is harmless.
 */
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  const results = [];
  for (const org of orgs) {
    // Daily backstop: every workspace has every bounce known in the organisation.
    const bouncesAdded = await syncOrgBounces(org.id).catch((err) => { console.error('[daily] bounce sync failed', err); return 0; });
    if (bouncesAdded) console.log(`[daily] added ${bouncesAdded} org-wide bounce(s) to workspaces that lacked them`);
    try {
      results.push(await dispatchDailyReport(org.id));
    } catch (err) {
      results.push({ organizationId: org.id, sent: false, reason: `error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return NextResponse.json({ ranAt: new Date(), results });
}
