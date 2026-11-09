import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));

import { dueReportDay, latestReportDay, previousIstDay, reportWindow, responseTimes, weekWindow, type DailyActivity } from '@/lib/digest/dailyActivity';
import { duration, renderDailyEmail, renderReportSlack } from '@/lib/digest/dailyEmail';
import type { NeedsAttention } from '@/lib/digest/needsAttention';

const t = (iso: string) => new Date(iso);

describe('daily report', () => {
  it('runs 8 PM to 8 PM; Monday reaches back to Friday 8 PM with the weekend as its own lines', () => {
    const tue = reportWindow('2026-11-10');
    expect(tue.from.toISOString()).toBe('2026-11-09T14:30:00.000Z'); // Mon 8 PM IST
    expect(tue.to.toISOString()).toBe('2026-11-10T14:30:00.000Z'); // Tue 8 PM IST
    expect(tue.segments.map((x) => x.label)).toEqual(['Monday after 8 PM', 'Tuesday until 8 PM']);

    const mon = reportWindow('2026-11-09');
    expect(mon.from.toISOString()).toBe('2026-11-06T14:30:00.000Z'); // Fri 8 PM IST
    expect(mon.to.toISOString()).toBe('2026-11-09T14:30:00.000Z');
    expect(mon.segments.map((x) => x.label)).toEqual(['Friday after 8 PM', 'Saturday', 'Sunday', 'Monday until 8 PM']);
    // The parts cover the window exactly, with no gaps.
    mon.segments.forEach((seg, i) => i && expect(seg.from.getTime()).toBe(mon.segments[i - 1]!.to.getTime()));
    expect(mon.segments.at(-1)!.to.getTime()).toBe(mon.to.getTime());
  });

  it('the weekly report covers last Monday to Sunday, one line per day', () => {
    const w = weekWindow(t('2026-11-09T03:30:00Z')); // Monday 9 AM IST
    expect(w.kind).toBe('weekly');
    expect(w.from.toISOString()).toBe('2026-11-01T18:30:00.000Z'); // Mon 2 Nov 00:00 IST
    expect(w.to.toISOString()).toBe('2026-11-08T18:30:00.000Z'); // Mon 9 Nov 00:00 IST
    expect(w.day).toBe('2026-11-08');
    expect(w.segments.map((x) => x.label)).toEqual(['Monday, 2 Nov', 'Tuesday, 3 Nov', 'Wednesday, 4 Nov', 'Thursday, 5 Nov', 'Friday, 6 Nov', 'Saturday, 7 Nov', 'Sunday, 8 Nov']);
  });

  it('is due at 8 PM IST on working days only, and a late run catches up until 8 AM', () => {
    expect(dueReportDay(t('2026-11-09T14:29:00Z'))).toBeNull(); // Mon 7:59 PM
    expect(dueReportDay(t('2026-11-09T14:31:00Z'))).toBe('2026-11-09'); // Mon 8:01 PM
    expect(dueReportDay(t('2026-11-10T01:00:00Z'))).toBe('2026-11-09'); // Tue 6:30 AM: Monday's, if missed
    expect(dueReportDay(t('2026-11-10T03:00:00Z'))).toBeNull(); // Tue 8:30 AM: too late, wait for tonight
    expect(dueReportDay(t('2026-11-07T15:00:00Z'))).toBeNull(); // Saturday evening
    expect(dueReportDay(t('2026-11-07T01:00:00Z'))).toBe('2026-11-06'); // Sat 6:30 AM: Friday's, if missed
    expect(latestReportDay(t('2026-11-08T10:00:00Z'))).toBe('2026-11-06'); // Sunday → Friday's
    expect(latestReportDay(t('2026-11-09T06:00:00Z'))).toBe('2026-11-06'); // Mon midday → Friday's
  });

  it('reports on the IST day before 09:00 IST', () => {
    const d = previousIstDay(t('2026-11-07T03:30:00Z')); // 9:00 IST, 7 Nov
    expect(d.ymd).toBe('2026-11-06');
    expect(d.from.toISOString()).toBe('2026-11-05T18:30:00.000Z');
    expect(d.to.toISOString()).toBe('2026-11-06T18:30:00.000Z');
  });

  it('FRT ignores a campaign email sent before the reply; ART pairs each wait with its answer', () => {
    const from = t('2026-11-06T00:00:00Z');
    const to = t('2026-11-07T00:00:00Z');
    const msgs = [
      { dir: 'OUTBOUND', at: t('2026-11-05T10:00:00Z') }, // the campaign email
      { dir: 'INBOUND', at: t('2026-11-06T09:00:00Z') },
      { dir: 'INBOUND', at: t('2026-11-06T09:30:00Z') },
      { dir: 'OUTBOUND', at: t('2026-11-06T10:00:00Z') }, // 60 min after the first waiting message
      { dir: 'INBOUND', at: t('2026-11-06T12:00:00Z') },
      { dir: 'OUTBOUND', at: t('2026-11-06T12:20:00Z') }, // 20 min
    ];
    expect(responseTimes(msgs, from, to)).toEqual({ frt: 60, art: [60, 20] });
    // Answers outside the window don't count.
    expect(responseTimes(msgs, t('2026-11-08T00:00:00Z'), t('2026-11-09T00:00:00Z'))).toEqual({ frt: null, art: [] });
  });

  it('formats durations briefly', () => {
    expect(duration(null)).toBe('—');
    expect(duration(42)).toBe('42m');
    expect(duration(190)).toBe('3h 10m');
    expect(duration(3000)).toBe('2d 2h');
  });

  it('leaves out people with nothing sent and columns that are 0 for everyone', () => {
    const zero = { CAMPAIGN: 0, QUICK_SEND: 0, RECRUITER: 0, INBOX_REPLY: 0 };
    const a: DailyActivity = {
      kind: 'daily',
      previous: null,
      from: t('2026-11-05T14:30:00Z'), // Thu 8 PM IST
      to: t('2026-11-06T14:30:00Z'), // Fri 8 PM IST
      ymd: '2026-11-06',
      segments: [
        { label: 'Thursday after 8 PM', main: false, emails: 3, people: 40, replies: 1 },
        { label: 'Friday until 8 PM', main: true, emails: 43, people: 6325, replies: 1 },
      ],
      totals: { emails: 46, people: 6365, failed: 0, borrowed: 46, senders: 1, mailboxes: 13, replies: 2, replyRate: 4.3 },
      bySource: [{ source: 'RECRUITER', emails: 46, people: 6365, failed: 0, borrowed: 46 }],
      users: [
        { userId: 'u1', name: 'Sender One', email: 's@x.com', workspace: 'WS', emails: 46, people: 6365, failed: 0, bySource: { ...zero, RECRUITER: 46 }, fromOwnMailbox: 0, fromOthersMailboxes: 46, othersUsedTheirMailbox: 0, replies: 2, lastAt: null, image: null },
        { userId: 'u2', name: 'Lender Two', email: 'l@x.com', workspace: 'WS2', emails: 0, people: 0, failed: 0, bySource: zero, fromOwnMailbox: 0, fromOthersMailboxes: 0, othersUsedTheirMailbox: 4, replies: 0, lastAt: null, image: null },
      ],
      pairs: [{ launchedBy: 'u1', launchedByName: 'Sender One', owner: 'u2', ownerName: 'Lender Two', mailbox: 'l@x.com', emails: 4, people: 608 }],
      inbox: [{ userId: 'u1', name: 'Sender One', email: 's@x.com', image: null, received: 2, pending: 1, closed: 1, frtDay: 30, artDay: 45, frt30: 120, art30: 90 }],
      inboxTotal: { received: 2, pending: 1, closed: 1, frtDay: 30, artDay: 45, frt30: 120, art30: 90 },
    };
    const d: NeedsAttention = { generatedAt: t('2026-11-07T03:30:00Z'), expiringDocuments: [], slaBreaches: [], pendingCampaigns: [], pendingUsers: [], unansweredReplies: [] };
    const { subject, html } = renderDailyEmail(a, d);
    expect(subject).toContain('Daily report · Friday, 6 November: 46 emails, 2 replies');
    expect(html).toContain('Thu 8 PM → Fri 8 PM');
    expect(html).toContain('Thursday after 8 PM');
    expect(html).toContain('added from after hours');
    const byUser = html.slice(html.indexOf('By user'), html.indexOf('Who used whose mailbox'));
    expect(byUser).toContain('Sender One');
    expect(byUser).not.toContain('Lender Two'); // nothing sent: only in "who used whose"
    expect(byUser).not.toContain('Own mailbox'); // 0 for everyone
    expect(byUser).toContain('Others&#39; mailboxes');
    expect(html).toContain('Lender <b>4</b>');
    expect(html).toContain('30m'); // FRT of the day
    expect(html).toContain('lfrom=2026-11-05&amp;lto=2026-11-06');
    expect(html).not.toContain('Quick Send'); // types with nothing sent are left out

    // Slack: the same report as Block Kit, with the after-hours line and nothing for zero rows.
    const slack = renderReportSlack(a, d);
    expect(slack.blocks[0]).toMatchObject({ type: 'header', text: { text: '📊 Daily report · Friday, 6 November' } });
    const all = JSON.stringify(slack.blocks);
    expect(all).toContain('Thursday after 8 PM');
    expect(all).toContain('Sender One');
    expect(all).not.toContain('*Lender Two*: 0 emails'); // nothing sent: not under By user
    expect(all).toContain('Nothing needs attention');
    expect(slack.text).toContain('46 emails to 6,365 people');
    for (const b of slack.blocks as { text?: { text: string } }[]) expect((b.text?.text ?? '').length).toBeLessThanOrEqual(3000);

    // Weekly: same design, day by day, compared with the week before.
    const week = renderDailyEmail({ ...a, kind: 'weekly', previous: { emails: 23, people: 6365, replies: 0 }, ymd: '2026-11-08', from: t('2026-11-01T18:30:00Z'), to: t('2026-11-08T18:30:00Z') }, d);
    expect(week.subject).toContain('Weekly report · 2 Nov – 8 Nov');
    expect(week.html).toContain('Day by day');
    expect(week.html).toContain('▲ 100% vs last week');
    expect(week.html).not.toContain('added from after hours');
  });
});
