import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { campaignStats } from '@/lib/quickSend/stats';

/** GET /api/quick-send/[id] — live progress and tracking for one send (polled by the Quick Send screen). */
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const owned = await prisma.campaign.findFirst({ where: { id: params.id, workspaceId: session.workspaceId ?? '' }, select: { id: true } });
  if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ stats: await campaignStats(owned.id) });
});
