import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { enqueueEmailJobs } from '@/lib/queue/queues';
import { CampaignStatus, BatchStatus, EmailJobStatus } from '@prisma/client';

/**
 * No-Redis fallback for scheduled campaign sends.
 * When BullMQ isn't available, SCHEDULED campaigns stay in the DB and this
 * cron fires every 5 minutes, picks up any whose scheduledAt has passed, and
 * enqueues/drains their PREPARING batches.
 *
 * When BullMQ IS available, the delayed jobs fire on their own and this cron
 * is a safety net that does nothing (all batches will already be QUEUED).
 */

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}` || new URL(req.url).searchParams.get('secret') === secret;
}

export async function GET(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const now = new Date();

  // Find all SCHEDULED campaigns whose scheduled time has arrived.
  const campaigns = await prisma.campaign.findMany({
    where: {
      status: CampaignStatus.SCHEDULED,
      scheduledAt: { lte: now },
    },
    select: { id: true },
  });

  if (campaigns.length === 0) {
    return NextResponse.json({ fired: 0 });
  }

  const campaignIds = campaigns.map((c) => c.id);

  // Find PREPARING batches (no-Redis path: jobs stay QUEUED in DB, batch is
  // still PREPARING because enqueueEmailJobs returned queued:false).
  const batches = await prisma.batch.findMany({
    where: {
      campaignId: { in: campaignIds },
      status: { in: [BatchStatus.PREPARING, BatchStatus.QUEUED] },
    },
    select: { id: true, campaignId: true },
  });

  let fired = 0;
  for (const batch of batches) {
    const jobs = await prisma.emailJob.findMany({
      where: { batchId: batch.id, status: EmailJobStatus.QUEUED },
      select: { id: true },
    });

    if (jobs.length === 0) continue;

    const result = await enqueueEmailJobs(
      jobs.map((j) => ({ emailJobId: j.id, batchId: batch.id }))
    );

    // Advance campaign to RUNNING immediately so the UI reflects reality.
    await prisma.campaign.update({
      where: { id: batch.campaignId },
      data: { status: CampaignStatus.RUNNING },
    });

    await prisma.batch.update({
      where: { id: batch.id },
      data: { status: result.queued ? BatchStatus.QUEUED : BatchStatus.PREPARING },
    });

    fired++;
  }

  return NextResponse.json({ fired, campaigns: campaignIds.length });
}
