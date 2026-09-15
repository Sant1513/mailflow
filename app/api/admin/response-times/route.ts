import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { parseDays, responseTimesByUser } from '@/lib/analytics/metrics';

/** §140 per-user FRT/ART for super admin. */
export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  if (session.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Super admin only' }, { status: 403 });
  }

  const url = new URL(req.url);
  const days = parseDays(url.searchParams.get('days') ?? undefined, 30);
  const rows = await responseTimesByUser(session.organizationId, days);

  return NextResponse.json({ rows, days });
});
