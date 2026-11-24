import { NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { listPayments } from '@/lib/orgs/billing';

export const dynamic = 'force-dynamic';

/** The organisation's payment / activation history, newest first. Super Admin only. */
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  const payments = await listPayments(session.organizationId, params.id);
  if (!payments) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ payments });
});
