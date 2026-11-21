import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { scanStatus } from '@/lib/email/bounceScan';

export const dynamic = 'force-dynamic';

/** How well the bounce scan is covering the organisation's mailboxes (shown on the Suppression List page). */
export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  return NextResponse.json(await scanStatus(session.organizationId));
});
