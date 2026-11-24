import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma, Role } from '@prisma/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { createOrgUnit, listOrgUnits, parseDomains } from '@/lib/orgs/units';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  name: z.string().trim().min(2, 'Give the organisation a name.').max(80),
  /** Domains its mailboxes may send from, e.g. "masaischool.com, neevlabs.ai" (blank = any domain). */
  domains: z.union([z.string(), z.array(z.string())]).optional(),
  /** Most ACTIVE people (blank / null = unlimited). */
  seatLimit: z.number().int().min(1).max(100000).nullable().optional(),
  /** Valid until this India date (YYYY-MM-DD), or for this many days from today; neither = no expiry. */
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  validDays: z.number().int().min(1).max(3650).optional(),
  graceDays: z.number().int().min(0).max(30).optional(),
  billingNote: z.string().trim().max(500).nullable().optional(),
});

/** Organisations of the company with their state, seats and validity, people and mailboxes. Super Admin only. */
export const GET = withErrorHandling(async () => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  return NextResponse.json({ orgUnits: await listOrgUnits(session.organizationId) });
});

export const POST = withErrorHandling(async (req) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  const body = createSchema.parse(await req.json());
  try {
    const r = await createOrgUnit(session, { ...body, domains: parseDomains(body.domains) });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ orgUnit: { id: r.value.id, name: r.value.name, domains: r.value.domains } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return NextResponse.json({ error: 'There is already an organisation with that name.' }, { status: 409 });
    throw err;
  }
});
