import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadBatchForSession } from '../route';
import { drainBatch, DEFAULT_DRAIN_LIMIT } from '@/lib/queue/drain';

const drainSchema = z.object({
  limit: z.number().int().min(1).max(50).default(DEFAULT_DRAIN_LIMIT),
});

/**
 * Processes a bounded slice of a batch. This is the send path for
 * deployments without Redis + a persistent worker (see lib/queue/drain.ts).
 *
 * It is capped per invocation and rate-limited per sender, so it does not
 * become the "send 500 emails in one HTTP request" anti-pattern §40 warns
 * about. Call it repeatedly (or from a cron ping) until `remaining` is 0.
 */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const batch = await loadBatchForSession(session, params.id);
  if (!batch) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = drainSchema.parse(await req.json().catch(() => ({})));
  const result = await drainBatch(batch.id, body.limit);

  await audit(session, 'BATCH_DRAIN', {
    targetType: 'Batch',
    targetId: batch.id,
    metadata: { sent: result.sent, failed: result.failed, remaining: result.remaining },
  });

  return NextResponse.json({
    ...result,
    note: result.rateLimited
      ? 'Stopped early: the per-minute send rate limit was reached. Call again shortly to continue.'
      : result.remaining > 0
        ? 'More jobs remain — call again to continue.'
        : 'Batch complete.',
  });
});
