import { NextResponse } from 'next/server';
import { BatchStatus, EmailJobStatus } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { cronAuthorised } from '@/lib/cron/auth';
import { kickSendWorker } from '@/lib/queue/sendWorker';
import { kickRecruiterWorker } from '@/lib/recruiterSend/worker';

export const maxDuration = 15;
export const dynamic = 'force-dynamic';

/**
 * The 15-minute backstop for both senders, in one cheap call (GitHub Actions): it only starts
 * the campaign sender or the recruiter sender when they have something to send, so idle hours
 * cost one small function call instead of two full sender runs (Vercel Hobby CPU limits).
 */
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const now = new Date();
  const [campaignEmails, recruiterSends] = await Promise.all([
    prisma.emailJob.count({ where: { status: EmailJobStatus.QUEUED, batch: { status: { in: [BatchStatus.PREPARING, BatchStatus.QUEUED, BatchStatus.RUNNING] } } } }),
    prisma.recruiterBlast.count({ where: { OR: [{ status: 'SENDING' }, { status: 'SCHEDULED', scheduledAt: { lte: now } }] } }),
  ]);
  if (campaignEmails > 0) kickSendWorker('dispatch');
  if (recruiterSends > 0) await kickRecruiterWorker('dispatch', { wait: true });
  return NextResponse.json({ campaignEmails, recruiterSends, startedCampaignSender: campaignEmails > 0, startedRecruiterSender: recruiterSends > 0 });
}
