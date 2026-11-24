import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma, Role } from '@prisma/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { deleteOrgUnit, parseDomains, updateOrgUnit } from '@/lib/orgs/units';

const patchSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  domains: z.union([z.string(), z.array(z.string())]).optional(),
  /** ACTIVE | DISABLED: a disabled organisation is locked completely. */
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  /** null = unlimited. Cannot be lowered below the people already active. */
  seatLimit: z.number().int().min(1).max(100000).nullable().optional(),
  /** null clears the expiry. */
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  graceDays: z.number().int().min(0).max(30).optional(),
  billingNote: z.string().trim().max(500).nullable().optional(),
});

export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  const body = patchSchema.parse(await req.json());
  try {
    const r = await updateOrgUnit(session, params.id, { ...body, domains: body.domains !== undefined ? parseDomains(body.domains) : undefined });
    if (!r) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ orgUnit: { id: r.value.id, name: r.value.name, domains: r.value.domains, status: r.value.status, seatLimit: r.value.seatLimit, validUntil: r.value.validUntil } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return NextResponse.json({ error: 'There is already an organisation with that name.' }, { status: 409 });
    throw err;
  }
});

/** Only an organisation nobody belongs to can be deleted: move its people first. */
export const DELETE = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  const result = await deleteOrgUnit(session, params.id);
  if (result === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (result === 'has_members') return NextResponse.json({ error: 'People still belong to this organisation. Move them to another one first.' }, { status: 409 });
  return NextResponse.json({ ok: true });
});
