import { describe, expect, it } from 'vitest';
import { compareValues, sortRows, nextSort } from '@/lib/ui/sort';
import { deviceOf, mailClientOf, median, hourBuckets, summariseOpeners, summariseClickers, topLinks, speedBands, parseSort, sortInMemory } from '@/lib/campaigns/analytics';

const d = (s: string) => new Date(s);

describe('sorting', () => {
  it('empty values go last in both directions', () => {
    const rows = [{ v: 2 }, { v: null }, { v: 5 }, { v: undefined }, { v: 1 }];
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.v)).toEqual([1, 2, 5, null, undefined]);
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.v)).toEqual([5, 2, 1, null, undefined]);
  });
  it('text ignores case and orders numbers inside text naturally', () => {
    expect(sortRows(['b10', 'B2', 'a1'], (x) => x, 'asc')).toEqual(['a1', 'B2', 'b10']);
  });
  it('dates, ISO strings and booleans compare by value; ties keep their order', () => {
    expect(compareValues(d('2026-01-02'), d('2026-01-01'), 'asc')).toBeGreaterThan(0);
    expect(compareValues('2026-11-25T10:00:00Z', '2026-11-25T09:00:00Z', 'desc')).toBeLessThan(0);
    const rows = [{ k: 1, n: 'a' }, { k: 1, n: 'b' }, { k: 0, n: 'c' }];
    expect(sortRows(rows, (r) => r.k, 'asc').map((r) => r.n)).toEqual(['c', 'a', 'b']);
  });
  it('clicking a header: new column starts at its natural way, the same column flips', () => {
    expect(nextSort({ key: 'a', dir: 'asc' }, 'b', 'desc')).toEqual({ key: 'b', dir: 'desc' });
    expect(nextSort({ key: 'b', dir: 'desc' }, 'b', 'desc')).toEqual({ key: 'b', dir: 'asc' });
  });
});

describe('opens', () => {
  const sentAt = new Map([['a@x.com', d('2026-11-25T10:00:00Z')], ['b@x.com', d('2026-11-25T10:00:00Z')]]);
  const opens = [
    { email: 'A@x.com', createdAt: d('2026-11-25T10:05:00Z'), userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17) Mobile' },
    { email: 'a@x.com', createdAt: d('2026-11-25T12:00:00Z'), userAgent: null },
    { email: 'a@x.com', createdAt: d('2026-11-26T09:00:00Z'), userAgent: null },
    { email: 'b@x.com', createdAt: d('2026-11-25T11:00:00Z'), userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' },
  ];
  const rows = summariseOpeners(opens, sentAt, [{ email: 'a@x.com', createdAt: d('2026-11-25T10:06:00Z'), url: 'https://l', userAgent: null }]);
  it('counts every open per person (case-insensitive), first/last, speed and clicks', () => {
    const a = rows.find((r) => r.email === 'a@x.com')!;
    expect(a).toMatchObject({ opens: 3, secondsToFirstOpen: 300, device: 'Mobile', clicks: 1 });
    expect(a.firstOpenedAt).toEqual(d('2026-11-25T10:05:00Z'));
    expect(a.lastOpenedAt).toEqual(d('2026-11-26T09:00:00Z'));
    expect(rows).toHaveLength(2);
  });
  it('sorts by times opened, biggest first', () => {
    expect(sortInMemory(rows as any, 'opens', 'desc').map((r: any) => r.email)).toEqual(['a@x.com', 'b@x.com']);
  });
  it('device, mail app, median, hours (India time), speed bands', () => {
    expect(deviceOf('iPad; CPU OS')).toBe('Tablet');
    expect(deviceOf(null)).toBe('Unknown');
    expect(mailClientOf('Mozilla GoogleImageProxy')).toBe('Gmail');
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3);
    expect(median([])).toBeNull();
    const h = hourBuckets([d('2026-11-25T18:30:00Z')]); // 00:00 next day IST
    expect(h[0]).toBe(1);
    expect(speedBands([60, 7200, 200000, null])).toEqual({ within1h: 1, within24h: 1, later: 1 });
  });
});

describe('clicks', () => {
  const clicks = [
    { email: 'a@x.com', createdAt: d('2026-11-25T10:00:00Z'), url: 'https://one', userAgent: null },
    { email: 'a@x.com', createdAt: d('2026-11-25T11:00:00Z'), url: 'https://one', userAgent: null },
    { email: 'a@x.com', createdAt: d('2026-11-25T12:00:00Z'), url: 'https://two', userAgent: null },
    { email: 'b@x.com', createdAt: d('2026-11-25T12:00:00Z'), url: 'https://one', userAgent: null },
  ];
  it('per person: clicks, different links, top link', () => {
    const a = summariseClickers(clicks).find((r) => r.email === 'a@x.com')!;
    expect(a).toMatchObject({ clicks: 3, links: 2, topUrl: 'https://one' });
  });
  it('which links work: clicks and distinct people', () => {
    expect(topLinks(clicks)).toEqual([{ url: 'https://one', clicks: 3, people: 2 }, { url: 'https://two', clicks: 1, people: 1 }]);
  });
});

describe('sort parameters', () => {
  it('only known columns are accepted; defaults are the newest first', () => {
    expect(parseSort('read', 'evil; drop', null)).toEqual({ key: 'lastOpenedAt', dir: 'desc' });
    expect(parseSort('read', 'opens', null)).toEqual({ key: 'opens', dir: 'desc' });
    expect(parseSort('sent', 'toEmail', null)).toEqual({ key: 'toEmail', dir: 'asc' });
    expect(parseSort('failed', 'errorCode', 'desc')).toEqual({ key: 'errorCode', dir: 'desc' });
  });
});
