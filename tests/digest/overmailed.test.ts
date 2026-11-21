import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRaw = vi.fn();
vi.mock('@/lib/db/client', () => ({ prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) } }));

import { collectOvermailed, collectOvermailedSafe, coolOffLine, overmailedLine, overmailedVisible, type Overmailed } from '@/lib/digest/overmailed';
import { renderDailyEmail, renderReportSlack } from '@/lib/digest/dailyEmail';
import type { DailyActivity } from '@/lib/digest/dailyActivity';
import type { NeedsAttention } from '@/lib/digest/needsAttention';

const t = (iso: string) => new Date(iso);
const NOW = t('2026-11-20T12:00:00Z');

const activity: DailyActivity = {
  kind: 'daily', previous: null, from: t('2026-11-19T14:30:00Z'), to: t('2026-11-20T14:30:00Z'), ymd: '2026-11-20',
  segments: [{ label: 'Friday until 8 PM', main: true, emails: 1, people: 1, replies: 0 }],
  totals: { emails: 1, people: 1, failed: 0, borrowed: 0, senders: 1, mailboxes: 1, replies: 0, replyRate: 0 },
  bySource: [], users: [], pairs: [], inbox: [],
  inboxTotal: { received: 0, pending: 0, closed: 0, frtDay: null, artDay: null, frt30: null, art30: null },
};
const needs: NeedsAttention = { generatedAt: NOW, expiringDocuments: [], slaBreaches: [], pendingCampaigns: [], pendingUsers: [], unansweredReplies: [] };

const over: Overmailed = {
  total: 12,
  coolOff: 2,
  people: [{ email: 'very.long.recruiter.name@some-extremely-long-company-domain.example.com', skippedSends: 5, lastSkippedAt: t('2026-11-18T10:00:00Z'), sample: 'Emailed 3 days ago' }],
};

beforeEach(() => { queryRaw.mockReset(); });

describe('collectOvermailed', () => {
  it('returns the people the query grouped, with numbers and a 120-character sample', async () => {
    queryRaw
      .mockResolvedValueOnce([
        { email: 'a@x.com', sends: 5n, lastAt: t('2026-11-18T10:00:00Z'), reason: 'x'.repeat(300), total: 14n },
        { email: 'b@x.com', sends: 3, lastAt: t('2026-11-10T10:00:00Z'), reason: null, total: 14 },
      ])
      .mockResolvedValueOnce([{ n: 4n }]);
    const o = await collectOvermailed('org1', NOW);
    expect(o.total).toBe(14);
    expect(o.coolOff).toBe(4);
    expect(o.people.map((p) => [p.email, p.skippedSends])).toEqual([['a@x.com', 5], ['b@x.com', 3]]);
    expect(o.people[0]!.sample).toHaveLength(120);
    expect(o.people[1]!.sample).toBe('');
  });

  it('keeps one row per inbox when two spellings come back (Gmail dots and +tags)', async () => {
    queryRaw
      .mockResolvedValueOnce([
        { email: 'a.b@gmail.com', sends: 3, lastAt: NOW, reason: '', total: 2 },
        { email: 'ab+x@gmail.com', sends: 4, lastAt: NOW, reason: '', total: 2 },
      ])
      .mockResolvedValueOnce([]);
    const o = await collectOvermailed('org1', NOW);
    expect(o.people).toHaveLength(1);
    expect(o.people[0]!.skippedSends).toBe(4);
  });

  it('asks only for this organisation, non-follow-ups, 30 days, at least 3 sends, top 10, and the fallback rule', async () => {
    queryRaw.mockResolvedValue([]);
    await collectOvermailed('org1', NOW);
    const first = queryRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
    expect(first.sql).toContain('mailflow_email_key');
    expect(first.sql).toContain('"parentBlastId" IS NULL');
    expect(first.sql).toContain("'RECENTLY_EMAILED'");
    expect(first.sql).toContain("LIKE 'Emailed %'");
    expect(first.sql).toContain("LIKE 'Already in %'");
    expect(first.values).toContain('org1');
    expect(first.values).toContain(3);
    expect(first.values).toContain(10);
    expect(first.values.find((v) => v instanceof Date)).toEqual(new Date(NOW.getTime() - 30 * 86_400_000));
    const second = queryRaw.mock.calls[1]![0] as { sql: string; values: unknown[] };
    expect(second.sql).toContain("'COOL_OFF'");
    expect(second.values.find((v) => v instanceof Date)).toEqual(new Date(NOW.getTime() - 7 * 86_400_000));
  });

  it('is hidden when nobody meets the rule and the cool-off count is 0', async () => {
    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ n: 0n }]);
    expect(await collectOvermailedSafe('org1', NOW)).toBeNull();
    expect(overmailedVisible({ people: [], total: 0, coolOff: 0 })).toBe(false);
    expect(overmailedVisible({ people: [], total: 0, coolOff: 1 })).toBe(true);
  });

  it('a collection error never breaks the report: the section is simply left out', async () => {
    queryRaw.mockImplementation(async () => { throw new Error('db down'); });
    await expect(collectOvermailedSafe('org1', NOW)).resolves.toBeNull();
    const { html } = renderDailyEmail(activity, needs, null);
    expect(html).not.toContain('Over-mailed');
  });
});

describe('Over-mailed recruiters section', () => {
  it('formats a line', () => {
    expect(overmailedLine({ email: 'name@company.com', skippedSends: 5, lastSkippedAt: t('2026-11-18T10:00:00Z'), sample: '' })).toBe('name@company.com: skipped in 5 sends in 30 days (last 18 Nov)');
    expect(coolOffLine(1)).toContain('1 person was');
    expect(coolOffLine(3)).toContain('3 people were');
  });

  it('shows in the email and in Slack, wrapping long addresses', () => {
    const { html } = renderDailyEmail(activity, needs, over);
    expect(html).toContain('Over-mailed recruiters');
    expect(html).toContain('skipped in 5 sends in 30 days (last 18 Nov)');
    expect(html).toContain('and 11 more');
    expect(html).toContain('2 people were skipped for a cool-off');
    expect(html).toContain('overflow-wrap:anywhere');
    expect(html).toContain('keep being emailed too soon');

    const all = JSON.stringify(renderReportSlack(activity, needs, {}, over).blocks);
    expect(all).toContain('*Over-mailed recruiters*');
    expect(all).toContain('skipped in 5 sends');
    expect(all).toContain('keep being emailed too soon');
  });

  it('is left out of the email and Slack when there is nothing to show', () => {
    expect(renderDailyEmail(activity, needs, { people: [], total: 0, coolOff: 0 }).html).not.toContain('Over-mailed');
    expect(renderDailyEmail(activity, needs).html).not.toContain('Over-mailed');
    expect(JSON.stringify(renderReportSlack(activity, needs, {}, { people: [], total: 0, coolOff: 0 }).blocks)).not.toContain('Over-mailed');
  });

  it('with only a cool-off count shows the one line and no footer', () => {
    const { html } = renderDailyEmail(activity, needs, { people: [], total: 0, coolOff: 3 });
    expect(html).toContain('3 people were skipped for a cool-off');
    expect(html).not.toContain('keep being emailed too soon');
  });
});
