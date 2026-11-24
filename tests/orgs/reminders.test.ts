import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Renewal reminders to the Super Admins (lib/orgs/reminders.ts): once per threshold, never to a disabled or never-ending organisation. */
const db = {
  orgUnit: { findMany: vi.fn(async (_q: any): Promise<any[]> => []), update: vi.fn(async (_q: any) => ({})) },
  user: { findMany: vi.fn(async (_q: any): Promise<any[]> => []) },
  notification: { createMany: vi.fn(async (q: any) => ({ count: q.data.length })) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));

const { sendRenewalReminders } = await import('@/lib/orgs/reminders');
const { parseUntilDate } = await import('@/lib/orgs/lifecycle');

const NOW = new Date('2026-11-25T12:00:00+05:30');
const until = (ymd: string) => parseUntilDate(ymd)!;
const o = (over: Record<string, unknown> = {}) => ({ id: 'o1', name: 'Neev Labs', status: 'ACTIVE', validUntil: until('2026-12-02'), graceDays: 0, lastReminderDays: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findMany.mockResolvedValue([
    { id: 'a1', ownedWorkspaces: [{ id: 'w1' }] },
    { id: 'a2', ownedWorkspaces: [{ id: 'w2' }] },
    { id: 'a3', ownedWorkspaces: [] }, // nowhere to put a notification: skipped
  ]);
});

describe('sendRenewalReminders', () => {
  it('tells every active Super Admin once at the threshold reached, and remembers it', async () => {
    db.orgUnit.findMany.mockResolvedValue([o()]); // 7 days left
    const r = await sendRenewalReminders('t1', NOW);
    expect(r.reminded).toEqual([{ orgUnitId: 'o1', name: 'Neev Labs', days: 7 }]);
    expect(r.notifications).toBe(2);
    const data = db.notification.createMany.mock.calls[0]![0].data;
    expect(data.map((d: any) => [d.userId, d.workspaceId, d.type])).toEqual([['a1', 'w1', 'ORG_RENEWAL'], ['a2', 'w2', 'ORG_RENEWAL']]);
    expect(data[0]).toMatchObject({ title: 'Neev Labs ends in 7 days', link: '/admin/organisations' });
    expect(db.orgUnit.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { lastReminderDays: 7 } });
  });

  it('does not repeat a threshold already sent (the job runs many times a day)', async () => {
    db.orgUnit.findMany.mockResolvedValue([o({ lastReminderDays: 7 })]);
    const r = await sendRenewalReminders('t1', NOW);
    expect(r.reminded).toEqual([]);
    expect(db.notification.createMany).not.toHaveBeenCalled();
    expect(db.orgUnit.update).not.toHaveBeenCalled();
  });

  it('sends the next threshold when it is reached', async () => {
    db.orgUnit.findMany.mockResolvedValue([o({ validUntil: until('2026-11-28'), lastReminderDays: 7 })]); // 3 days left
    const r = await sendRenewalReminders('t1', NOW);
    expect(r.reminded[0]).toMatchObject({ days: 3 });
  });

  it('says "ends today" on the last day', async () => {
    db.orgUnit.findMany.mockResolvedValue([o({ validUntil: until('2026-11-25'), lastReminderDays: 1 })]);
    await sendRenewalReminders('t1', NOW);
    expect(db.notification.createMany.mock.calls[0]![0].data[0].title).toBe('Neev Labs ends today');
  });

  it('nothing for far-off, expired or never-ending organisations', async () => {
    db.orgUnit.findMany.mockResolvedValue([o({ validUntil: until('2027-06-01') }), o({ id: 'o2', validUntil: until('2026-11-01') }), o({ id: 'o3', validUntil: null })]);
    const r = await sendRenewalReminders('t1', NOW);
    expect(r.reminded).toEqual([]);
  });

  it('asks only for enabled organisations that have an end date', async () => {
    await sendRenewalReminders('t1', NOW);
    expect(db.orgUnit.findMany.mock.calls[0]![0].where).toEqual({ organizationId: 't1', status: 'ACTIVE', validUntil: { not: null } });
  });

  it('with no Super Admin to tell it still remembers the threshold', async () => {
    db.orgUnit.findMany.mockResolvedValue([o()]);
    db.user.findMany.mockResolvedValue([]);
    const r = await sendRenewalReminders('t1', NOW);
    expect(r.notifications).toBe(0);
    expect(db.orgUnit.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { lastReminderDays: 7 } });
  });
});
