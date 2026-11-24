import { describe, expect, it } from 'vitest';
import { accessMessage, accessOf, endOfDayIST, newValidUntil, parseUntilDate, reminderDue, seatStatus } from '@/lib/orgs/lifecycle';

// 25 Nov 2026, 12:00 India time
const NOW = new Date('2026-11-25T12:00:00+05:30');
const until = (ymd: string) => parseUntilDate(ymd)!;
const org = (over: Partial<{ status: string; validUntil: Date | null; graceDays: number; lastReminderDays: number | null }> = {}) => ({ status: 'ACTIVE', validUntil: null as Date | null, graceDays: 0, lastReminderDays: null as number | null, ...over });

describe('dates are India time', () => {
  it('"valid until 30 Nov" ends at 23:59:59 IST that day', () => {
    expect(until('2026-11-30').toISOString()).toBe('2026-11-30T18:29:59.999Z');
    expect(endOfDayIST(new Date('2026-11-30T01:00:00+05:30')).toISOString()).toBe('2026-11-30T18:29:59.999Z');
  });
  it('rejects a malformed date', () => {
    expect(parseUntilDate('30-11-2026')).toBeNull();
    expect(parseUntilDate('2026-13-45')).toBeNull();
  });
});

describe('the state of an organisation', () => {
  it('no expiry is always active', () => {
    expect(accessOf(org(), NOW)).toMatchObject({ state: 'ACTIVE', lock: 'none', daysLeft: null, level: null });
  });
  it('more than 30 days left is quiet', () => {
    expect(accessOf(org({ validUntil: until('2026-12-31') }), NOW)).toMatchObject({ state: 'ACTIVE', lock: 'none', daysLeft: 36 });
  });
  it('30 days or fewer shows the banner, getting more urgent', () => {
    expect(accessOf(org({ validUntil: until('2026-12-25') }), NOW)).toMatchObject({ state: 'EXPIRING', daysLeft: 30, level: 'info' });
    expect(accessOf(org({ validUntil: until('2026-12-09') }), NOW)).toMatchObject({ state: 'EXPIRING', daysLeft: 14, level: 'warning' });
    expect(accessOf(org({ validUntil: until('2026-12-02') }), NOW)).toMatchObject({ state: 'EXPIRING', daysLeft: 7, level: 'urgent' });
    expect(accessOf(org({ validUntil: until('2026-11-26') }), NOW)).toMatchObject({ state: 'EXPIRING', daysLeft: 1, level: 'urgent' });
  });
  it('the last day is still fully open ("ends today")', () => {
    expect(accessOf(org({ validUntil: until('2026-11-25') }), NOW)).toMatchObject({ state: 'EXPIRING', lock: 'none', daysLeft: 0 });
  });
  it('the day after, with no grace, only the Dashboard is left', () => {
    expect(accessOf(org({ validUntil: until('2026-11-24') }), NOW)).toMatchObject({ state: 'EXPIRED', lock: 'dashboard', daysLeft: -1, level: 'urgent' });
  });
  it('grace days keep everything open, with a red banner, until they pass', () => {
    const o = org({ validUntil: until('2026-11-24'), graceDays: 3 });
    expect(accessOf(o, NOW)).toMatchObject({ state: 'GRACE', lock: 'none', level: 'urgent' });
    expect(accessOf(o, new Date('2026-11-28T12:00:00+05:30'))).toMatchObject({ state: 'EXPIRED', lock: 'dashboard' });
  });
  it('a disabled organisation is locked completely, whatever its dates', () => {
    expect(accessOf(org({ status: 'DISABLED' }), NOW)).toMatchObject({ state: 'DISABLED', lock: 'full' });
    expect(accessOf(org({ status: 'DISABLED', validUntil: until('2027-01-01') }), NOW)).toMatchObject({ state: 'DISABLED', lock: 'full' });
  });
});

describe('activating or extending', () => {
  it('"add N days" counts from today when expired or never set', () => {
    expect(newValidUntil({ mode: 'days', days: 30 }, null, NOW)!.toISOString()).toBe(until('2026-12-25').toISOString());
    expect(newValidUntil({ mode: 'days', days: 30 }, until('2026-11-01'), NOW)!.toISOString()).toBe(until('2026-12-25').toISOString());
  });
  it('"add N days" counts from the current end date when it is still ahead (renewing early loses nothing)', () => {
    expect(newValidUntil({ mode: 'days', days: 30 }, until('2026-12-10'), NOW)!.toISOString()).toBe(until('2027-01-09').toISOString());
  });
  it('"valid until a date" uses that date', () => {
    expect(newValidUntil({ mode: 'until', until: '2027-03-31' }, null, NOW)!.toISOString()).toBe(until('2027-03-31').toISOString());
  });
  it('refuses zero or negative days, a past date and a silly length', () => {
    expect(newValidUntil({ mode: 'days', days: 0 }, null, NOW)).toBeNull();
    expect(newValidUntil({ mode: 'days', days: -5 }, null, NOW)).toBeNull();
    expect(newValidUntil({ mode: 'days', days: 99999 }, null, NOW)).toBeNull();
    expect(newValidUntil({ mode: 'until', until: '2026-11-01' }, null, NOW)).toBeNull();
    expect(newValidUntil({ mode: 'until', until: 'soon' }, null, NOW)).toBeNull();
  });
});

describe('seats', () => {
  it('unlimited when no limit is set', () => {
    expect(seatStatus(null, 500)).toEqual({ used: 500, limit: null, full: false, left: null });
  });
  it('full at the limit, with the seats left', () => {
    expect(seatStatus(5, 4)).toEqual({ used: 4, limit: 5, full: false, left: 1 });
    expect(seatStatus(5, 5)).toEqual({ used: 5, limit: 5, full: true, left: 0 });
    expect(seatStatus(5, 7)).toMatchObject({ full: true, left: 0 });
  });
});

describe('renewal reminders to the Super Admins', () => {
  it('each threshold is due once, the smallest one reached', () => {
    expect(reminderDue(org({ validUntil: until('2026-12-25') }), NOW)).toBe(30);
    expect(reminderDue(org({ validUntil: until('2026-12-25'), lastReminderDays: 30 }), NOW)).toBeNull();
    expect(reminderDue(org({ validUntil: until('2026-12-03'), lastReminderDays: 30 }), NOW)).toBe(14); // 8 days left
    expect(reminderDue(org({ validUntil: until('2026-12-02'), lastReminderDays: 14 }), NOW)).toBe(7);
    expect(reminderDue(org({ validUntil: until('2026-11-25'), lastReminderDays: 1 }), NOW)).toBe(0);
  });
  it('none for no expiry, far-off dates, expired or disabled organisations', () => {
    expect(reminderDue(org(), NOW)).toBeNull();
    expect(reminderDue(org({ validUntil: until('2027-06-01') }), NOW)).toBeNull();
    expect(reminderDue(org({ validUntil: until('2026-11-01') }), NOW)).toBeNull();
    expect(reminderDue(org({ status: 'DISABLED', validUntil: until('2026-11-30') }), NOW)).toBeNull();
  });
});

describe('the words', () => {
  it('say what is happening and what to do', () => {
    expect(accessMessage(accessOf(org({ validUntil: until('2026-12-02') }), NOW), 'Neev Labs')!.title).toBe('Neev Labs ends in 7 days');
    expect(accessMessage(accessOf(org({ validUntil: until('2026-11-24') }), NOW), 'Neev Labs')!.body).toMatch(/Only the Dashboard/);
    expect(accessMessage(accessOf(org(), NOW), 'Neev Labs')).toBeNull();
  });
});
