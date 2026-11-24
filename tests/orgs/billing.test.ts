import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Activating / extending an organisation after a payment (lib/orgs/billing.ts) and editing its lifecycle fields
 * (updateOrgUnit: status, seat limit, validity, grace days).
 */
const org = (over: Record<string, unknown> = {}) => ({ id: 'o1', organizationId: 't1', name: 'Neev Labs', domains: [] as string[], status: 'ACTIVE', validUntil: null, graceDays: 0, seatLimit: null, ...over });
const db = {
  orgUnit: {
    findFirst: vi.fn(async (_q: any): Promise<any> => null),
    update: vi.fn(async (q: any): Promise<any> => ({ ...org(), domains: [], id: q.where.id, ...q.data })),
    create: vi.fn(async (q: any): Promise<any> => ({ id: 'new', ...q.data })),
  },
  orgPayment: { create: vi.fn(async (q: any): Promise<any> => ({ id: 'p1', ...q.data })), findMany: vi.fn(async (_q: any): Promise<any[]> => []) },
  user: { groupBy: vi.fn(async (_q: any): Promise<any[]> => []), findMany: vi.fn(async (_q: any): Promise<any[]> => []) },
  $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
const audit = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/lib/audit/log', () => ({ audit: (...a: unknown[]) => audit(...a) }));

const { activateOrg, listPayments } = await import('@/lib/orgs/billing');
const units = await import('@/lib/orgs/units');
const { parseUntilDate } = await import('@/lib/orgs/lifecycle');

const NOW = new Date('2026-11-25T12:00:00+05:30');
const session: any = { userId: 'sa1', organizationId: 't1', role: 'SUPER_ADMIN', orgUnitId: 'o-masai' };
const until = (ymd: string) => parseUntilDate(ymd)!;


beforeEach(() => {
  vi.clearAllMocks();
  db.orgUnit.findFirst.mockResolvedValue(org());
});

describe('activating after a payment', () => {
  it('a first activation: counts days from today, records the payment, and is an ACTIVATE', async () => {
    const r = await activateOrg({ session, orgUnitId: 'o1', mode: 'days', days: 30, amountMinor: 2500000, reference: 'UTR123', note: 'Annual plan, first month' }, NOW);
    expect(r).toMatchObject({ ok: true, kind: 'ACTIVATE' });
    if (!r?.ok) throw new Error('x');
    expect(r.validUntil.toISOString()).toBe(until('2026-12-25').toISOString());
    expect(db.orgUnit.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { validUntil: r.validUntil, lastReminderDays: null } });
    expect(db.orgPayment.create.mock.calls[0]![0].data).toMatchObject({ orgUnitId: 'o1', kind: 'ACTIVATE', amountMinor: 2500000, currency: 'INR', reference: 'UTR123', days: 30, previousValidUntil: null, recordedById: 'sa1' });
    expect(audit).toHaveBeenCalledWith(session, 'ORG_ACTIVATE', expect.objectContaining({ targetId: 'o1' }));
  });

  it('renewing while still running is an EXTEND, counted from the current end date (nothing lost)', async () => {
    db.orgUnit.findFirst.mockResolvedValue(org({ validUntil: until('2026-12-10') }));
    const r = await activateOrg({ session, orgUnitId: 'o1', mode: 'days', days: 30 }, NOW);
    expect(r).toMatchObject({ ok: true, kind: 'EXTEND' });
    if (!r?.ok) throw new Error('x');
    expect(r.validUntil.toISOString()).toBe(until('2027-01-09').toISOString());
    expect(db.orgPayment.create.mock.calls[0]![0].data.previousValidUntil).toEqual(until('2026-12-10'));
    expect(audit).toHaveBeenCalledWith(session, 'ORG_EXTEND', expect.anything());
  });

  it('after a lapse it counts from today and is an ACTIVATE again; the organisation is open straight away', async () => {
    db.orgUnit.findFirst.mockResolvedValue(org({ validUntil: until('2026-11-01') }));
    const r = await activateOrg({ session, orgUnitId: 'o1', mode: 'days', days: 90 }, NOW);
    expect(r).toMatchObject({ ok: true, kind: 'ACTIVATE' });
    if (!r?.ok) throw new Error('x');
    expect(r.access).toMatchObject({ state: 'ACTIVE', lock: 'none' });
  });

  it('"valid until a date" uses that date', async () => {
    const r = await activateOrg({ session, orgUnitId: 'o1', mode: 'until', until: '2027-03-31' }, NOW);
    expect(r).toMatchObject({ ok: true });
    if (!r?.ok) throw new Error('x');
    expect(r.validUntil.toISOString()).toBe(until('2027-03-31').toISOString());
    expect(db.orgPayment.create.mock.calls[0]![0].data.days).toBeNull();
  });

  it('refuses bad days, a past date, or a negative amount, and records nothing', async () => {
    for (const bad of [
      { mode: 'days' as const, days: 0 },
      { mode: 'days' as const, days: 5000 },
      { mode: 'until' as const, until: '2026-01-01' },
      { mode: 'until' as const, until: 'tomorrow' },
      { mode: 'days' as const, days: 30, amountMinor: -5 },
    ]) {
      const r = await activateOrg({ session, orgUnitId: 'o1', ...bad }, NOW);
      expect(r).toMatchObject({ ok: false, status: 400 });
    }
    expect(db.orgPayment.create).not.toHaveBeenCalled();
    expect(db.orgUnit.update).not.toHaveBeenCalled();
  });

  it('an organisation outside the company is not found', async () => {
    db.orgUnit.findFirst.mockResolvedValue(null);
    expect(await activateOrg({ session, orgUnitId: 'zzz', mode: 'days', days: 30 }, NOW)).toBeNull();
  });
});

describe('the payment history', () => {
  it('lists newest first with who recorded it', async () => {
    db.orgPayment.findMany.mockResolvedValue([{ id: 'p2', kind: 'EXTEND', amountMinor: 100, currency: 'INR', reference: null, note: null, days: 30, previousValidUntil: until('2026-12-10'), validUntil: until('2027-01-09'), recordedById: 'sa1', createdAt: NOW }]);
    db.user.findMany.mockResolvedValue([{ id: 'sa1', name: 'Abhi' }]);
    const rows = await listPayments('t1', 'o1');
    expect(db.orgPayment.findMany.mock.calls[0]![0]).toMatchObject({ where: { orgUnitId: 'o1' }, orderBy: { createdAt: 'desc' } });
    expect(rows![0]).toMatchObject({ id: 'p2', recordedBy: 'Abhi', days: 30 });
  });
  it('null for an organisation outside the company', async () => {
    db.orgUnit.findFirst.mockResolvedValue(null);
    expect(await listPayments('t1', 'zzz')).toBeNull();
  });
});

describe('editing the lifecycle fields', () => {
  it('disabling and enabling are audited as such, and change only the status', async () => {
    const off = await units.updateOrgUnit(session, 'o1', { status: 'DISABLED' }, NOW);
    expect(off).toMatchObject({ ok: true });
    expect(db.orgUnit.update.mock.calls[0]![0].data).toEqual({ status: 'DISABLED' });
    expect(audit).toHaveBeenLastCalledWith(session, 'ORG_DISABLE', expect.objectContaining({ metadata: expect.objectContaining({ changes: { status: ['ACTIVE', 'DISABLED'] } }) }));
    db.orgUnit.findFirst.mockResolvedValue(org({ status: 'DISABLED' }));
    await units.updateOrgUnit(session, 'o1', { status: 'ACTIVE' }, NOW);
    expect(audit).toHaveBeenLastCalledWith(session, 'ORG_ENABLE', expect.anything());
  });

  it('lowering the seat limit below the people already active is refused, with the numbers', async () => {
    db.user.groupBy.mockResolvedValue([{ orgUnitId: 'o1', _count: { _all: 4 } }]);
    const r = await units.updateOrgUnit(session, 'o1', { seatLimit: 2 }, NOW);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect((r as any).error).toMatch(/4 people are active in Neev Labs.*cannot be 2.*Disable or move 2 people/);
    expect(db.orgUnit.update).not.toHaveBeenCalled();
  });
  it('a seat limit at or above the active people is fine, and null means unlimited', async () => {
    db.user.groupBy.mockResolvedValue([{ orgUnitId: 'o1', _count: { _all: 4 } }]);
    expect(await units.updateOrgUnit(session, 'o1', { seatLimit: 4 }, NOW)).toMatchObject({ ok: true });
    expect(await units.updateOrgUnit(session, 'o1', { seatLimit: null }, NOW)).toMatchObject({ ok: true });
    expect(db.orgUnit.update.mock.calls[1]![0].data).toEqual({ seatLimit: null });
  });
  it('rejects a seat limit that is not a whole number from 1, and grace days out of range', async () => {
    expect(await units.updateOrgUnit(session, 'o1', { seatLimit: 0 }, NOW)).toMatchObject({ ok: false, status: 400 });
    expect(await units.updateOrgUnit(session, 'o1', { seatLimit: 2.5 }, NOW)).toMatchObject({ ok: false, status: 400 });
    expect(await units.updateOrgUnit(session, 'o1', { graceDays: 31 }, NOW)).toMatchObject({ ok: false, status: 400 });
    expect(await units.updateOrgUnit(session, 'o1', { graceDays: 7 }, NOW)).toMatchObject({ ok: true });
  });

  it('setting, changing or clearing the end date resets the reminders; a past date is refused', async () => {
    const set = await units.updateOrgUnit(session, 'o1', { validUntil: '2027-01-31' }, NOW);
    expect(set).toMatchObject({ ok: true });
    expect(db.orgUnit.update.mock.calls[0]![0].data).toEqual({ validUntil: until('2027-01-31'), lastReminderDays: null });
    await units.updateOrgUnit(session, 'o1', { validUntil: null }, NOW);
    expect(db.orgUnit.update.mock.calls[1]![0].data).toEqual({ validUntil: null, lastReminderDays: null });
    expect(await units.updateOrgUnit(session, 'o1', { validUntil: '2026-01-01' }, NOW)).toMatchObject({ ok: false, status: 400 });
  });

  it('an organisation outside the company is not found', async () => {
    db.orgUnit.findFirst.mockResolvedValue(null);
    expect(await units.updateOrgUnit(session, 'zzz', { status: 'DISABLED' }, NOW)).toBeNull();
  });
});

describe('creating with seats and validity', () => {
  it('may carry a seat limit, a number of valid days, a grace period and a note', async () => {
    const r = await units.createOrgUnit(session, { name: 'Acme', domains: ['acme.com'], seatLimit: 2, validDays: 30, graceDays: 3, billingNote: ' Acme Pvt Ltd ' });
    expect(r.ok).toBe(true);
    const data = db.orgUnit.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ organizationId: 't1', name: 'Acme', domains: ['acme.com'], seatLimit: 2, graceDays: 3, billingNote: 'Acme Pvt Ltd' });
    expect(data.validUntil).toBeInstanceOf(Date);
  });
  it('defaults to unlimited seats and no expiry (existing behaviour)', async () => {
    await units.createOrgUnit(session, { name: 'Plain' });
    expect(db.orgUnit.create.mock.calls[0]![0].data).toMatchObject({ seatLimit: null, validUntil: null, graceDays: 0 });
  });
  it('refuses a bad seat limit or bad days', async () => {
    expect(await units.createOrgUnit(session, { name: 'X', seatLimit: 0 })).toMatchObject({ ok: false, status: 400 });
    expect(await units.createOrgUnit(session, { name: 'X', validDays: 0 })).toMatchObject({ ok: false, status: 400 });
    expect(db.orgUnit.create).not.toHaveBeenCalled();
  });
});
