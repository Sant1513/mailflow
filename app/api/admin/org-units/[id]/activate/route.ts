import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { activateOrg } from '@/lib/orgs/billing';

const common = {
  /** Amount in the smallest unit (paise / cents). */
  amountMinor: z.number().int().min(0).max(1_000_000_000_000).nullable().optional(),
  currency: z.string().trim().length(3).optional(),
  reference: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
};
const bodySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('days'), days: z.number().int().min(1, 'Days must be at least 1.').max(3650, 'Days cannot be more than 3650.'), ...common }),
  z.object({ mode: z.literal('until'), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date.'), ...common }),
]);

/**
 * Activate or extend an organisation after its payment arrived: "add N days" or "valid until a date". Records the payment
 * (amount, reference, note) and returns the new end date. Super Admin only.
 */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Check the days or the date.' }, { status: 400 });
  const r = await activateOrg({ session, orgUnitId: params.id, ...parsed.data });
  if (!r) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, kind: r.kind, previousValidUntil: r.previousValidUntil, validUntil: r.validUntil, state: r.access.state, daysLeft: r.access.daysLeft });
});
