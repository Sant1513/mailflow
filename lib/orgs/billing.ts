import { prisma } from '@/lib/db/client';
import { audit } from '@/lib/audit/log';
import type { AppSession } from '@/lib/auth/session';
import { accessOf, newValidUntil, type OrgAccess } from '@/lib/orgs/lifecycle';

/**
 * Activating or extending an organisation once its payment has arrived (payment itself is taken outside MailFlow).
 * Each activation is saved as an OrgPayment: the audit trail now, and the base for invoicing later. A payment gateway can call
 * activateOrg from its webhook with the same input.
 */

export type ActivateInput = (
  | { mode: 'days'; days: number }
  | { mode: 'until'; until: string }
) & {
  /** Amount in the smallest unit (paise / cents), when recorded. */
  amountMinor?: number | null;
  currency?: string;
  /** Transaction id / invoice number. */
  reference?: string | null;
  note?: string | null;
};

export type ActivateResult =
  | { ok: true; paymentId: string; kind: 'ACTIVATE' | 'EXTEND'; previousValidUntil: Date | null; validUntil: Date; access: OrgAccess }
  | { ok: false; status: number; error: string };

/**
 * Sets the organisation's end date and records the payment. "Add N days" counts from today, or from the current end date when it
 * is still ahead (renewing early loses nothing). The kind is ACTIVATE when the organisation had no end date or had lapsed (or was
 * disabled), EXTEND when it was still running. A disabled organisation is not enabled by this: enabling is a separate decision.
 */
export async function activateOrg(input: { session: AppSession; orgUnitId: string } & ActivateInput, now: Date = new Date()): Promise<ActivateResult | null> {
  const { session, orgUnitId } = input;
  const org = await prisma.orgUnit.findFirst({ where: { id: orgUnitId, organizationId: session.organizationId } });
  if (!org) return null;

  const until = input.mode === 'days' ? newValidUntil({ mode: 'days', days: input.days }, org.validUntil, now) : newValidUntil({ mode: 'until', until: input.until }, null, now);
  if (!until) {
    return { ok: false, status: 400, error: input.mode === 'days' ? 'Days must be a whole number from 1 to 3650.' : 'Choose a valid date in the future (YYYY-MM-DD).' };
  }
  if (input.amountMinor !== undefined && input.amountMinor !== null && (!Number.isInteger(input.amountMinor) || input.amountMinor < 0)) {
    return { ok: false, status: 400, error: 'The amount must be zero or more.' };
  }

  const before = accessOf(org, now);
  const kind: 'ACTIVATE' | 'EXTEND' = !org.validUntil || before.state === 'EXPIRED' || before.state === 'DISABLED' || before.state === 'GRACE' ? 'ACTIVATE' : 'EXTEND';
  const [, payment] = await prisma.$transaction([
    prisma.orgUnit.update({ where: { id: org.id }, data: { validUntil: until, lastReminderDays: null } }),
    prisma.orgPayment.create({
      data: {
        orgUnitId: org.id,
        kind,
        amountMinor: input.amountMinor ?? null,
        currency: (input.currency ?? 'INR').toUpperCase().slice(0, 3),
        reference: input.reference?.trim() || null,
        note: input.note?.trim() || null,
        days: input.mode === 'days' ? input.days : null,
        previousValidUntil: org.validUntil,
        validUntil: until,
        recordedById: session.userId,
      },
    }),
  ]);
  await audit(session, kind === 'ACTIVATE' ? 'ORG_ACTIVATE' : 'ORG_EXTEND', {
    targetType: 'OrgUnit',
    targetId: org.id,
    metadata: { name: org.name, from: org.validUntil, to: until, days: input.mode === 'days' ? input.days : null, amountMinor: input.amountMinor ?? null, reference: input.reference ?? null },
  });
  return { ok: true, paymentId: payment.id, kind, previousValidUntil: org.validUntil, validUntil: until, access: accessOf({ status: org.status, validUntil: until, graceDays: org.graceDays }, now) };
}

export interface PaymentRow {
  id: string;
  kind: string;
  amountMinor: number | null;
  currency: string;
  reference: string | null;
  note: string | null;
  days: number | null;
  previousValidUntil: string | null;
  validUntil: string | null;
  recordedBy: string | null;
  createdAt: string;
}

/** The organisation's payment history, newest first (null when it is not in the company). */
export async function listPayments(organizationId: string, orgUnitId: string, limit = 100): Promise<PaymentRow[] | null> {
  const org = await prisma.orgUnit.findFirst({ where: { id: orgUnitId, organizationId }, select: { id: true } });
  if (!org) return null;
  const rows = await prisma.orgPayment.findMany({ where: { orgUnitId }, orderBy: { createdAt: 'desc' }, take: limit });
  const people = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.recordedById))] } }, select: { id: true, name: true } });
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amountMinor: r.amountMinor,
    currency: r.currency,
    reference: r.reference,
    note: r.note,
    days: r.days,
    previousValidUntil: r.previousValidUntil ? r.previousValidUntil.toISOString() : null,
    validUntil: r.validUntil ? r.validUntil.toISOString() : null,
    recordedBy: nameOf.get(r.recordedById) ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}
