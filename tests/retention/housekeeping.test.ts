import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Daily housekeeping keeps the database inside the free 500 MB: old notifications, audit entries,
 * finished webhook deliveries and expired sessions go; emails, conversations and History never do.
 */
const db = {
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  $executeRawUnsafe: vi.fn(async () => 0),
  organization: { findMany: vi.fn(async () => [{ id: 'org1' }]) },
  retentionPolicy: { findMany: vi.fn(async (): Promise<any[]> => []) },
  verificationToken: { deleteMany: vi.fn(async () => ({ count: 2 })) },
  integrationSettings: { upsert: vi.fn(async () => ({})) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/settings/org', () => ({ getOrgSettings: vi.fn(async () => ({ senderAccountId: null })) }));
const notify = {
  emailsForRoles: vi.fn(async () => ['boss@masaischool.com']),
  postAlertDm: vi.fn(async () => 'SENT to U1'),
  sendSystemEmail: vi.fn(async () => 'SENT to 1'),
  systemEmailShell: vi.fn((_t: string, _i: string, body: string) => body),
};
vi.mock('@/lib/notify/system', () => notify);

const { runDailyHousekeeping, auditKeepDays, KEEP_DAYS } = await import('@/lib/retention/housekeeping');

const sqlOf = (call: any[]) => (call[0] as string[]).join('?');
const MB = 1024 * 1024;
const now = new Date('2026-11-10T20:30:00Z');

let openTables: { name: string }[] = [];
function usage(dbBytes: number, storageBytes: number | 'missing') {
  db.$queryRaw.mockImplementation(async (strings: string[]) => {
    const sql = strings.join('?');
    if (sql.includes('relrowsecurity')) return openTables;
    if (sql.includes('pg_database_size')) return [{ bytes: BigInt(dbBytes) }];
    if (storageBytes === 'missing') throw new Error('relation "storage.objects" does not exist');
    return [{ bytes: BigInt(storageBytes) }];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  openTables = [];
  db.$executeRaw.mockResolvedValue(0);
  usage(48 * MB, 0);
});

describe('daily housekeeping', () => {
  it('turns Row-Level Security on for any table that has it off (Supabase API lock)', async () => {
    openTables = [{ name: 'NewTable' }];
    const r = await runDailyHousekeeping({ now });
    expect(r.rlsEnabled).toEqual(['NewTable']);
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith('ALTER TABLE public."NewTable" ENABLE ROW LEVEL SECURITY');
  });

  it('does nothing when every table already has RLS', async () => {
    const r = await runDailyHousekeeping({ now });
    expect(r.rlsEnabled).toEqual([]);
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('deletes only notifications, audit log, finished webhook deliveries and expired sessions', async () => {
    db.$executeRaw.mockResolvedValueOnce(3).mockResolvedValueOnce(4).mockResolvedValueOnce(5).mockResolvedValueOnce(6);
    const r = await runDailyHousekeeping({ now });
    expect(r.deleted).toEqual({ notifications: 3, auditLogs: 4, webhookDeliveries: 5, sessions: 6, verificationTokens: 2 });
    const sqls = db.$executeRaw.mock.calls.map(sqlOf);
    expect(sqls[0]).toContain('DELETE FROM "Notification"');
    expect(sqls[1]).toContain('DELETE FROM "AuditLog"');
    expect(sqls[2]).toContain('DELETE FROM "WebhookDelivery"');
    expect(sqls[2]).toContain(`"status" <> 'PENDING'`);
    expect(sqls[3]).toContain('DELETE FROM "Session"');
    for (const s of sqls) expect(s).not.toMatch(/EmailJob|ConversationMessage|Conversation"|History|Contact|Record/);
  });

  it('uses the keep windows: 90 days of notifications, 365 of audit log, 30 of webhook deliveries', async () => {
    await runDailyHousekeeping({ now });
    const cutoffs = db.$executeRaw.mock.calls.map((c) => c.find((v: unknown) => v instanceof Date) as Date);
    const days = (d: Date) => Math.round((now.getTime() - d.getTime()) / 86_400_000);
    expect(days(cutoffs[0]!)).toBe(KEEP_DAYS.notifications);
    expect(days(cutoffs[1]!)).toBe(KEEP_DAYS.auditLog);
    expect(days(cutoffs[2]!)).toBe(KEEP_DAYS.webhookDeliveries);
    expect(cutoffs[3]).toEqual(now); // sessions: expired ones only
  });

  it('keeps audit entries longer when the retention policy asks for longer, never shorter than a year', () => {
    expect(auditKeepDays(null)).toBe(365);
    expect(auditKeepDays(90)).toBe(365);
    expect(auditKeepDays(730)).toBe(730);
  });

  it('deletes in batches of 5,000 until a batch comes back short', async () => {
    db.$executeRaw.mockResolvedValueOnce(5000).mockResolvedValueOnce(5000).mockResolvedValueOnce(12);
    const r = await runDailyHousekeeping({ now });
    expect(r.deleted.notifications).toBe(10_012);
    expect(sqlOf(db.$executeRaw.mock.calls[0]!)).toContain('LIMIT');
  });

  it('stops when the time budget is spent', async () => {
    db.$executeRaw.mockImplementation(async () => {
      await new Promise((res) => setTimeout(res, 15));
      return 5000;
    });
    const r = await runDailyHousekeeping({ now, budgetMs: 10 });
    expect(r.outOfTime).toBe(true);
    expect(db.$executeRaw.mock.calls.length).toBe(1);
  });
});

describe('free-plan warning', () => {
  it('no warning under the limits', async () => {
    const r = await runDailyHousekeeping({ now });
    expect(r.usage).toEqual({ databaseBytes: 48 * MB, storageBytes: 0 });
    expect(r.warnings).toEqual([]);
    expect(notify.postAlertDm).not.toHaveBeenCalled();
  });

  it('warns super admins by Slack and email once a day when the database passes 350 MB', async () => {
    usage(360 * MB, 0);
    db.$executeRaw.mockImplementation(async (strings: string[]) => (strings.join('?').includes('lastUsageAlertOn') ? 1 : 0));
    const r = await runDailyHousekeeping({ now });
    expect(r.warnings).toEqual(['Database is 360 MB of the free 500 MB']);
    expect(notify.postAlertDm).toHaveBeenCalledTimes(1);
    expect(notify.sendSystemEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ['boss@masaischool.com'] }));
  });

  it('a second run the same day finds the alert already claimed and stays quiet', async () => {
    usage(360 * MB, 800 * MB);
    db.$executeRaw.mockResolvedValue(0);
    const r = await runDailyHousekeeping({ now });
    expect(r.warnings).toHaveLength(2);
    expect(notify.postAlertDm).not.toHaveBeenCalled();
  });

  it('no Supabase Storage schema (laptop database): storage is simply not measured', async () => {
    usage(10 * MB, 'missing');
    const r = await runDailyHousekeeping({ now });
    expect(r.usage.storageBytes).toBeNull();
    expect(r.warnings).toEqual([]);
  });
});
