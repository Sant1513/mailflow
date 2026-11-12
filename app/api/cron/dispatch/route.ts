import { NextResponse } from 'next/server';
import { BatchStatus, EmailJobStatus } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { cronAuthorised } from '@/lib/cron/auth';
import { kickSendWorker } from '@/lib/queue/sendWorker';
import { kickRecruiterWorker, takeOverSilentLaptopSends } from '@/lib/recruiterSend/worker';
import { dueReportDay } from '@/lib/digest/dailyActivity';
import { dispatchDailyReport } from '@/lib/digest/dispatch';
import { controlDb } from '@/lib/system/serverState';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * The 15-minute backstop for both senders, in one cheap call (GitHub Actions): it only starts
 * the campaign sender or the recruiter sender when they have something to send, so idle hours
 * cost one small function call instead of two full sender runs (Vercel Hobby CPU limits).
 * After 8 PM IST on working days it also sends the daily report if it hasn't gone out yet.
 */
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const now = new Date();
  // "The timer is alive" for the laptop's watch (start.mjs warns when this is hours old).
  // Raw so SystemState.updatedAt, which marks real switch changes, is left alone.
  await controlDb().$executeRaw`UPDATE "SystemState" SET "lastDispatchAt" = now() WHERE "id" = 'main'`.catch((err: unknown) => console.error('[dispatch] lastDispatchAt', err));
  // Sends running on the laptop are left to it, unless it has gone quiet: then they move to
  // the cloud here and count below.
  await takeOverSilentLaptopSends(now).catch((err: unknown) => console.error('[dispatch] laptop take-over', err));
  const [campaignEmails, recruiterSends] = await Promise.all([
    prisma.emailJob.count({ where: { status: EmailJobStatus.QUEUED, batch: { status: { in: [BatchStatus.PREPARING, BatchStatus.QUEUED, BatchStatus.RUNNING] } } } }),
    prisma.recruiterBlast.count({ where: { runOn: { not: 'laptop' }, OR: [{ status: 'SENDING' }, { status: 'SCHEDULED', scheduledAt: { lte: now } }] } }),
  ]);
  if (campaignEmails > 0) kickSendWorker('dispatch');
  if (recruiterSends > 0) await kickRecruiterWorker('dispatch', { wait: true });
  // The daily report: only looked at once a report is due (8 PM–8 AM, Monday to Friday).
  let dailyReport: unknown = null;
  if (dueReportDay(now)) {
    const orgs = await prisma.organization.findMany({ select: { id: true } });
    dailyReport = await Promise.all(orgs.map((o) => dispatchDailyReport(o.id, { now }).catch((err: Error) => ({ organizationId: o.id, sent: false, reason: `error: ${err.message}` }))));
  }
  return NextResponse.json({ campaignEmails, recruiterSends, startedCampaignSender: campaignEmails > 0, startedRecruiterSender: recruiterSends > 0, dailyReport });
}
