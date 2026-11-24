import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Seats: the most ACTIVE people an organisation may have. Pending people do not use one. */
const orgs: Record<string, { name: string; seatLimit: number | null }> = { o5: { name: 'Neev Labs', seatLimit: 5 }, oU: { name: 'Operations', seatLimit: null } };
let active = 0;
const db = {
  orgUnit: { findUnique: vi.fn(async (q: any) => orgs[q.where.id] ?? null) },
  user: { count: vi.fn(async (_q: any) => active) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
const seats = await import('@/lib/orgs/seats');

beforeEach(() => {
  vi.clearAllMocks();
  active = 0;
});

describe('seats', () => {
  it('counts only ACTIVE people', async () => {
    active = 3;
    expect(await seats.activeSeats('o5')).toBe(3);
    expect(db.user.count).toHaveBeenCalledWith({ where: { orgUnitId: 'o5', status: 'ACTIVE' } });
  });
  it('a free seat is fine', async () => {
    active = 4;
    expect(await seats.seatProblem('o5')).toBeNull();
    await expect(seats.assertSeatAvailable('o5')).resolves.toBeUndefined();
  });
  it('a full organisation refuses, with the numbers', async () => {
    active = 5;
    expect(await seats.seatProblem('o5')).toBe('5 of 5 seats used in Neev Labs. Raise the limit or disable someone.');
    await expect(seats.assertSeatAvailable('o5')).rejects.toMatchObject({ status: 409, code: 'SEAT_LIMIT' });
  });
  it('no limit means no refusal, however many people', async () => {
    active = 500;
    expect(await seats.seatProblem('oU')).toBeNull();
  });
  it('no organisation or an unknown one is not a seat problem', async () => {
    expect(await seats.seatProblem(null)).toBeNull();
    expect(await seats.seatProblem('nope')).toBeNull();
  });
  it('the person being approved or moved is not counted against themselves', async () => {
    active = 4;
    await seats.seatProblem('o5', 'u9');
    expect(db.user.count).toHaveBeenCalledWith({ where: { orgUnitId: 'o5', status: 'ACTIVE', id: { not: 'u9' } } });
  });
  it('seat status for the admin page', async () => {
    active = 2;
    expect(await seats.seatsOf('o5')).toMatchObject({ used: 2, limit: 5, left: 3, full: false, orgName: 'Neev Labs' });
    expect(await seats.seatsOf('nope')).toBeNull();
  });
});
