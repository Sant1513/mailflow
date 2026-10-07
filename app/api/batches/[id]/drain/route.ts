import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadBatchForSession } from '@/lib/campaigns/batchAccess';
import { prisma } from '@/lib/db/client';
import { kickSendWorker, runSendWorker } from '@/lib/queue/sendWorker';

export const maxDuration = 60;

const drainSchema = z.object({
  /** Seconds to keep sending in this request (the open campaign page uses short passes). */
  seconds: z.number().int().min(5).max(45).default(40),
  /** Kept for older clients; the worker now sends until time runs out. */
  limit: z.number().int().optional(),
});

/**
 * "Process queue": sends this batch's queued emails for up to ~40 s (3 s
 * apart, within the per-minute limit), then hands any remainder to the
 * background worker so sending carries on with the tab closed.
 */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const batch = await loadBatchForSession(session, params.id);
  if (!batch) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = drainSchema.parse(await req.json().catch(() => ({})));
  const result = await runSendWorker({ budgetMs: body.seconds * 1000, batchId: batch.id });
  if (!result.busy && !result.held && result.remaining > 0) kickSendWorker('process-queue', { continuation: true });

  const after = await prisma.batch.findUnique({ where: { id: batch.id }, select: { status: true } });
  await audit(session, 'BATCH_DRAIN', {
    targetType: 'Batch',
    targetId: batch.id,
    metadata: { sent: result.sent, failed: result.failed, remaining: result.remaining },
  });

  return NextResponse.json({
    ...result,
    processed: result.sent + result.failed,
    batchStatus: after?.status,
    note: result.held
      ? "On hold to stay within Google's sending limits (daily limit reached or Gmail asked to slow down). Sending resumes automatically."
      : result.busy
        ? 'Already sending in the background.'
      : result.remaining > 0
        ? 'Sending continues automatically in the background.'
        : 'Batch complete.',
  });
});
