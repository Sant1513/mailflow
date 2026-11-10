import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The weekly report is claimed before sending (like the daily one), so two schedulers can't
 * both send it, and released when nothing went out, so the week's report isn't lost.
 */
const db = {
  integrationSettings: { upsert: vi.fn(async () => ({})) },
  $executeRaw: vi.fn(async (..._args: unknown[]) => 1),
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));

const settings = {
  senderAccountId: null,
  lastWeeklyReportOn: '2026-11-02' as string | null,
  digest: {},
  weeklyReport: { enabled: true, emailSuperAdmins: true, extraEmails: [] as string[], slack: true, slackChannel: '' },
};
vi.mock('@/lib/settings/org', () => ({ getOrgSettings: vi.fn(async () => settings) }));

const sendSystemEmail = vi.fn(async (_input: unknown) => 'SENT');
const postSystemSlack = vi.fn(async (..._args: unknown[]) => 'SENT');
vi.mock('@/lib/notify/system', () => ({
  emailsForRoles: vi.fn(async () => ['boss@masaischool.com']),
  sendSystemEmail: (input: unknown) => sendSystemEmail(input),
  postSystemSlack: (...args: unknown[]) => postSystemSlack(...args),
}));
vi.mock('@/lib/digest/needsAttention', () => ({ collectNeedsAttention: vi.fn(async () => ({})), digestTotal: vi.fn(() => 0) }));
vi.mock('@/lib/digest/dailyActivity', () => ({
  collectDailyActivity: vi.fn(async () => ({})),
  dueReportDay: vi.fn(),
  latestReportDay: vi.fn(),
  reportWindow: vi.fn(),
  weekWindow: vi.fn(() => ({})),
}));
vi.mock('@/lib/digest/dailyEmail', () => ({
  renderDailyEmail: vi.fn(() => ({ subject: 'Weekly', html: '<p>w</p>' })),
  renderReportSlack: vi.fn(() => ({ text: 'w', blocks: [] })),
}));

const { dispatchWeeklyReport } = await import('@/lib/digest/dispatch');

/** The SQL of an $executeRaw call (tagged template: strings, then values; Prisma.raw values inlined). */
const sqlOf = (call: unknown[]) => {
  const [strings, ...values] = call as [string[], ...unknown[]];
  return strings.reduce((out, s, i) => {
    const v = values[i] as { sql?: string } | undefined;
    return out + s + (i < values.length ? (typeof v?.sql === 'string' ? v.sql : '?') : '');
  }, '');
};

const MONDAY_9AM_IST = new Date('2026-11-09T03:30:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  db.$executeRaw.mockResolvedValue(1);
  sendSystemEmail.mockResolvedValue('SENT');
  postSystemSlack.mockResolvedValue('SENT');
});

describe('weekly report — once a week, never lost', () => {
  it('claims the day before sending, on the weekly marker', async () => {
    const r = await dispatchWeeklyReport('org1', { now: MONDAY_9AM_IST });
    expect(r.sent).toBe(true);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1); // the claim; nothing released
    expect(sqlOf(db.$executeRaw.mock.calls[0]!)).toContain('lastWeeklyReportOn');
    expect(sendSystemEmail).toHaveBeenCalledTimes(1);
  });

  it('does not send when another run already claimed today', async () => {
    db.$executeRaw.mockResolvedValueOnce(0);
    const r = await dispatchWeeklyReport('org1', { now: MONDAY_9AM_IST });
    expect(r).toMatchObject({ sent: false, reason: 'already sent today' });
    expect(sendSystemEmail).not.toHaveBeenCalled();
    expect(postSystemSlack).not.toHaveBeenCalled();
  });

  it('releases the day when both the email and Slack failed, so a later run retries', async () => {
    sendSystemEmail.mockResolvedValue('FAILED: no mailbox');
    postSystemSlack.mockResolvedValue('FAILED: channel_not_found');
    const r = await dispatchWeeklyReport('org1', { now: MONDAY_9AM_IST });
    expect(r.sent).toBe(false);
    expect(db.$executeRaw).toHaveBeenCalledTimes(2); // claim + release
    expect(sqlOf(db.$executeRaw.mock.calls[1]!)).toContain('lastWeeklyReportOn');
  });

  it('releases the day when building the report throws', async () => {
    sendSystemEmail.mockRejectedValue(new Error('boom'));
    await expect(dispatchWeeklyReport('org1', { now: MONDAY_9AM_IST })).rejects.toThrow('boom');
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('a test send never claims or releases the marker', async () => {
    await dispatchWeeklyReport('org1', { now: MONDAY_9AM_IST, testTo: 'me@masaischool.com' });
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});
