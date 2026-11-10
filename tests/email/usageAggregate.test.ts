import { describe, expect, it, vi } from 'vitest';

/**
 * usageLast24h now asks the database for three aggregates (messages, recipients, distinct
 * addresses) instead of loading every sent email of the day. Its SQL was checked against the old
 * JavaScript on every mailbox of the standby database (identical for all 18); these tests pin the
 * mapping and how the limits read it.
 */
const db = { $queryRaw: vi.fn() };
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/email/processJob', () => ({ processEmailJob: vi.fn(), reconcileBatchStatus: vi.fn() }));

const { usageLast24h, usageFromAggregate, wouldExceedDaily } = await import('@/lib/queue/drain');

describe('usageLast24h aggregate', () => {
  it('maps bigint counts and the distinct addresses', async () => {
    db.$queryRaw.mockResolvedValueOnce([{ messages: 3n, total: 7n, uniq: ['a@x.com', 'b@x.com'] }]);
    const u = await usageLast24h('acc1');
    expect(u.messages).toBe(3);
    expect(u.totalRecipients).toBe(7);
    expect([...u.unique].sort()).toEqual(['a@x.com', 'b@x.com']);
  });

  it('nothing sent: zeros and an empty set (array_agg gives null)', () => {
    const u = usageFromAggregate({ messages: 0n, total: 0n, uniq: null });
    expect(u).toEqual({ messages: 0, totalRecipients: 0, unique: new Set() });
    expect(usageFromAggregate(undefined).messages).toBe(0);
  });

  it('only filters by this mailbox and the last 24 hours', async () => {
    db.$queryRaw.mockResolvedValueOnce([{ messages: 0, total: 0, uniq: null }]);
    const before = Date.now();
    await usageLast24h('acc-42');
    const [strings, ...values] = db.$queryRaw.mock.calls.at(-1)!;
    const sql = (strings as string[]).join('?');
    expect(sql).toContain('"EmailJob"');
    expect(sql).toContain('"RecruiterBlastGroup"');
    expect(values.filter((v) => v === 'acc-42')).toHaveLength(2);
    const since = values.find((v) => v instanceof Date) as Date;
    expect(before - since.getTime()).toBeGreaterThanOrEqual(24 * 3600_000 - 1000);
  });

  it('known addresses do not count again towards the distinct-recipient limit', () => {
    const u = usageFromAggregate({ messages: 1, total: 1, uniq: ['a@x.com'] });
    expect(wouldExceedDaily(u, { toEmail: 'A@x.com ', ccEmails: [], bccEmails: [] })).toBe(false);
  });
});
