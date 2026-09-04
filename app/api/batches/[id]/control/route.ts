import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadBatchForSession } from '@/lib/campaigns/batchAccess';
import { enqueueEmailJobs } from '@/lib/queue/queues';
import { BatchStatus, CampaignStatus, EmailJobStatus } from '@prisma/client';

const controlSchema = z.object({
  action: z.enum(['PAUSE', 'RESUME', 'CANCEL', 'RETRY_FAILED']),
});

/**
 * §43 pause / resume / cancel, and §42 retry-failed.
 *
 * Pause and cancel take effect between jobs: processEmailJob re-reads the
 * batch status immediately before each send, so an in-flight message
 * finishes safely but the next one does not start.
 */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const batch = await loadBatchForSession(session, params.id);
  if (!batch) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { action } = controlSchema.parse(await req.json());

  if (action === 'PAUSE') {
    if (batch.status === BatchStatus.COMPLETED || batch.status === BatchStatus.CANCELLED) {
      return NextResponse.json({ error: `Cannot pause a ${batch.status} batch.` }, { status: 400 });
    }
    const updated = await prisma.batch.update({ where: { id: batch.id }, data: { status: BatchStatus.PAUSED } });
    await prisma.campaign.update({ where: { id: batch.campaignId }, data: { status: CampaignStatus.PAUSED } });
    await audit(session, 'BATCH_PAUSE', { targetType: 'Batch', targetId: batch.id });
    return NextResponse.json({ batch: updated });
  }

  if (action === 'RESUME') {
    if (batch.status !== BatchStatus.PAUSED) {
      return NextResponse.json({ error: `Only a paused batch can resume (this one is ${batch.status}).` }, { status: 400 });
    }
    const updated = await prisma.batch.update({ where: { id: batch.id }, data: { status: BatchStatus.QUEUED } });
    await prisma.campaign.update({ where: { id: batch.campaignId }, data: { status: CampaignStatus.RUNNING } });

    // Re-enqueue anything still queued so the worker picks it back up.
    const pending = await prisma.emailJob.findMany({
      where: { batchId: batch.id, status: EmailJobStatus.QUEUED },
      select: { id: true },
    });
    await enqueueEmailJobs(pending.map((j) => ({ emailJobId: j.id, batchId: batch.id })));

    await audit(session, 'BATCH_RESUME', { targetType: 'Batch', targetId: batch.id, metadata: { requeued: pending.length } });
    return NextResponse.json({ batch: updated, requeued: pending.length });
  }

  if (action === 'CANCEL') {
    if (batch.status === BatchStatus.COMPLETED) {
      return NextResponse.json({ error: 'Batch already completed.' }, { status: 400 });
    }
    // Cancel only what has not gone out. Already-sent messages cannot be
    // unsent, and are left exactly as they are.
    const cancelled = await prisma.emailJob.updateMany({
      where: { batchId: batch.id, status: EmailJobStatus.QUEUED },
      data: { status: EmailJobStatus.CANCELLED, skipReason: 'Batch cancelled by user.' },
    });
    const updated = await prisma.batch.update({
      where: { id: batch.id },
      data: { status: BatchStatus.CANCELLED, skippedCount: { increment: cancelled.count } },
    });
    await prisma.campaign.update({ where: { id: batch.campaignId }, data: { status: CampaignStatus.CANCELLED } });
    await audit(session, 'BATCH_CANCEL', {
      targetType: 'Batch',
      targetId: batch.id,
      metadata: { cancelledJobs: cancelled.count },
    });
    return NextResponse.json({ batch: updated, cancelled: cancelled.count });
  }

  // RETRY_FAILED — §42: retries only the failures, never the successes.
  const failed = await prisma.emailJob.findMany({
    where: { batchId: batch.id, status: EmailJobStatus.FAILED },
    select: { id: true, errorCode: true, retryCount: true },
  });

  const maxAttempts = Number(process.env.EMAIL_MAX_ATTEMPTS ?? 4);
  // Permanent failures are not retried — retrying an invalid address forever
  // helps nobody and burns sending quota.
  const permanent = new Set(['INVALID_RECIPIENT', 'NO_SENDER']);
  const retryable = failed.filter((j) => !permanent.has(j.errorCode ?? '') && j.retryCount < maxAttempts);

  await prisma.emailJob.updateMany({
    where: { id: { in: retryable.map((j) => j.id) } },
    data: { status: EmailJobStatus.QUEUED, errorCode: null, errorMessage: null },
  });
  await prisma.batch.update({
    where: { id: batch.id },
    data: {
      status: BatchStatus.QUEUED,
      failedCount: Math.max(0, batch.failedCount - retryable.length),
    },
  });
  await enqueueEmailJobs(retryable.map((j) => ({ emailJobId: j.id, batchId: batch.id })));

  await audit(session, 'BATCH_RETRY_FAILED', {
    targetType: 'Batch',
    targetId: batch.id,
    metadata: { retried: retryable.length, permanentlyFailed: failed.length - retryable.length },
  });

  return NextResponse.json({
    retried: retryable.length,
    notRetried: failed.length - retryable.length,
    note:
      failed.length - retryable.length > 0
        ? 'Some failures are permanent (invalid recipient, or max attempts reached) and were not retried.'
        : undefined,
  });
});
