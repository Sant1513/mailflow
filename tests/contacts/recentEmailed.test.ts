import { describe, expect, it } from 'vitest';
import {
  coolOffBadgeText,
  coolOffBodySchema,
  coolOffInputValue,
  emailedCondition,
  emailedQuery,
  isCoolingOff,
  lastEmailedText,
  likeContains,
  parseCoolOffDate,
  parseEmailedFilter,
  relativeDays,
} from '@/lib/contacts/recentEmailed';
import { Prisma } from '@prisma/client';

const now = new Date('2026-11-20T10:00:00Z');
const expr = Prisma.sql`"primaryEmail"`;

describe('emailed filter parsing', () => {
  it('defaults to Any / 10 days and only accepts 3, 7, 10, 30', () => {
    expect(parseEmailedFilter(new URLSearchParams(''))).toEqual({ mode: 'any', days: 10 });
    expect(parseEmailedFilter(new URLSearchParams('emailed=within&emailedDays=7'))).toEqual({ mode: 'within', days: 7 });
    expect(parseEmailedFilter(new URLSearchParams('emailed=not&emailedDays=30'))).toEqual({ mode: 'not', days: 30 });
    expect(parseEmailedFilter(new URLSearchParams('emailed=bogus&emailedDays=5'))).toEqual({ mode: 'any', days: 10 });
  });
  it('builds the query string only when the filter is on', () => {
    expect(emailedQuery({ mode: 'any', days: 10 })).toBe('');
    expect(emailedQuery({ mode: 'not', days: 3 })).toBe('&emailed=not&emailedDays=3');
  });
});

describe('emailedCondition', () => {
  it('is no restriction for Any', () => {
    expect(emailedCondition(expr, 'any', ['a@b.com'])).toBeNull();
  });
  it('within: nobody matches when nobody was emailed', () => {
    expect(emailedCondition(expr, 'within', [])?.sql).toBe('FALSE');
  });
  it('not: everybody matches when nobody was emailed', () => {
    expect(emailedCondition(expr, 'not', [])).toBeNull();
  });
  it('matches on the email key, keeping people without an address in "not"', () => {
    const w = emailedCondition(expr, 'within', ['a@b.com'])!;
    expect(w.sql).toContain('mailflow_email_key("primaryEmail")');
    expect(w.sql).toContain('ANY(');
    expect(w.values).toEqual([['a@b.com']]);
    const n = emailedCondition(expr, 'not', ['a@b.com'])!;
    expect(n.sql).toMatch(/^NOT COALESCE\(/);
    expect(n.sql).toContain('FALSE');
  });
});

describe('likeContains', () => {
  it('escapes wildcard characters', () => {
    expect(likeContains(' 50%_off\\ ')).toBe('%50\\%\\_off\\\\%');
  });
});

describe('last emailed text', () => {
  it('says how long ago, with subject and source in the tooltip', () => {
    const t = lastEmailedText({ at: '2026-11-17T10:00:00Z', subject: 'Hello', source: 'Campaign “A”', from: 'me@x.com' }, now);
    expect(t.label).toBe('3 days ago');
    expect(t.title).toBe('“Hello” · Campaign “A” · from me@x.com');
    expect(t.never).toBe(false);
  });
  it('is muted text when never emailed', () => {
    expect(lastEmailedText(null, now)).toMatchObject({ label: 'Never emailed from MailFlow', never: true });
  });
  it('uses today, yesterday, weeks and months', () => {
    expect(relativeDays('2026-11-20T01:00:00Z', now)).toBe('today');
    expect(relativeDays('2026-11-19T01:00:00Z', now)).toBe('yesterday');
    expect(relativeDays('2026-11-01T10:00:00Z', now)).toBe('2 weeks ago');
    expect(relativeDays('2026-06-20T10:00:00Z', now)).toBe('5 months ago');
  });
  it('shortens a very long subject', () => {
    const t = lastEmailedText({ at: '2026-11-19T10:00:00Z', subject: 'x'.repeat(200), source: 'Inbox reply', from: null }, now);
    expect(t.title.length).toBeLessThan(120);
  });
});

describe('cool-off', () => {
  it('parses a date as the start of that day in India and rejects non-dates', () => {
    expect(parseCoolOffDate('2026-11-28')?.toISOString()).toBe('2026-11-27T18:30:00.000Z');
    expect(parseCoolOffDate('2026-02-31')).toBeNull();
    expect(parseCoolOffDate('28/11/2026')).toBeNull();
    expect(parseCoolOffDate('')).toBeNull();
  });
  it('round-trips through the date input and the badge', () => {
    const d = parseCoolOffDate('2026-11-28')!;
    expect(coolOffInputValue(d)).toBe('2026-11-28');
    expect(coolOffInputValue(null)).toBe('');
    expect(coolOffBadgeText(d)).toBe('Do not contact until 28 Nov');
  });
  it('is running only while the date is in the future', () => {
    expect(isCoolingOff('2026-11-28T00:00:00Z', now)).toBe(true);
    expect(isCoolingOff('2026-11-01T00:00:00Z', now)).toBe(false);
    expect(isCoolingOff(null, now)).toBe(false);
  });
  it('validates the body: null clears, valid date ok, bad / far dates and long notes rejected', () => {
    expect(coolOffBodySchema.safeParse({ doNotContactUntil: null }).success).toBe(true);
    expect(coolOffBodySchema.safeParse({ doNotContactUntil: '2099-01-01' }).success).toBe(false);
    expect(coolOffBodySchema.safeParse({ doNotContactUntil: 'soon' }).success).toBe(false);
    expect(coolOffBodySchema.safeParse({ doNotContactUntil: '2026-13-01' }).success).toBe(false);
    expect(coolOffBodySchema.safeParse({ doNotContactUntil: null, coolOffNote: 'x'.repeat(201) }).success).toBe(false);
    const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    expect(coolOffBodySchema.safeParse({ doNotContactUntil: soon, coolOffNote: 'x'.repeat(200) }).success).toBe(true);
    const far = new Date(Date.now() + 800 * 86_400_000).toISOString().slice(0, 10);
    expect(coolOffBodySchema.safeParse({ doNotContactUntil: far }).success).toBe(false);
  });
});
