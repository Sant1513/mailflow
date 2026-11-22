import { NextResponse } from 'next/server';
import { isSuperAdmin, requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { scanStatus } from '@/lib/email/bounceScan';

export const dynamic = 'force-dynamic';

/**
 * How well the bounce scan is covering the organisation's mailboxes (shown on the Suppression List page).
 * A super admin also gets one line per mailbox (owner, last synced, notices read, error) and `canSync`.
 */
export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  const admin = isSuperAdmin(session);
  const status = await scanStatus(session.organizationId, Date.now(), { mailboxes: admin });
  return NextResponse.json({ ...status, canSync: admin });
});
