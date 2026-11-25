import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { cronAuthorised } from '@/lib/cron/auth';
import { sendApprovalDigest } from '@/lib/campaigns/approvalDigest';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * The approvals summary email (lib/campaigns/approvalDigest.ts): one email listing what is waiting, at most once per the
 * organisation's chosen interval, instead of an email for every request. Called every 15 minutes by the scheduled-jobs
 * workflow; it does one cheap read and sends only when something new is waiting, so calling it more often is harmless.
 */
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  const results = [];
  for (const org of orgs) {
    try {
      results.push(await sendApprovalDigest(org.id));
    } catch (err) {
      results.push({ organizationId: org.id, sent: false, reason: `error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return NextResponse.json({ ranAt: new Date(), results });
}
