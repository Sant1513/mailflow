import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { loadCampaignForSession } from '@/lib/campaigns/context';
import { startCampaignSend } from '@/lib/campaigns/startSend';

// Creating one snapshot per recipient (plus document values) takes longer
// than the default function limit for large campaigns.
export const maxDuration = 60;

const sendSchema = z.object({
  /** §36: policy escape hatch for low-risk sends by authorized users. */
  skipApproval: z.boolean().default(false),
  /** §41 Force Resend — audited. */
  force: z.boolean().default(false),
  /** ISO 8601 datetime — schedule the send for a future time instead of immediately. */
  scheduledAt: z.string().datetime().optional(),
});

/**
 * §33/§39/§40: validates, snapshots one EmailJob per recipient and hands
 * them to the queue (see lib/campaigns/startSend.ts). Never sends inline.
 */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const body = sendSchema.parse(await req.json().catch(() => ({})));

  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const result = await startCampaignSend({
    campaign,
    actor: session,
    skipApproval: body.skipApproval,
    force: body.force,
    scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
    via: 'campaign-page',
  });
  return NextResponse.json(result.body, { status: result.status });
});
