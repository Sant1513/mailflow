import { describe, it, expect } from 'vitest';
import { applyView, compareValues, flatten, matchesSearch, parseViewQuery, sortRecords, viewQuerySchema } from '@/lib/records/query';

const rows = [
  { id: 'a', data: { Name: 'Rahul', Score: '82', Status: 'Ready', Deadline: '2026-09-12' }, emailStatus: 'SENT', replyReceived: true, createdAt: new Date('2026-09-01T00:00:00Z') },
  { id: 'b', data: { Name: 'anita', Score: 9, Status: 'Pending', Deadline: '2026-09-05' }, emailStatus: 'FAILED', replyReceived: false, createdAt: new Date('2026-09-02T00:00:00Z') },
  { id: 'c', data: { Name: 'Zoya', Score: '', Status: 'Ready', Deadline: '' }, emailStatus: null, replyReceived: false, createdAt: new Date('2026-09-03T00:00:00Z') },
  { id: 'd', data: { Name: 'Bala', Score: '100', Status: '', Deadline: '2026-08-30' }, emailStatus: 'SENT', replyReceived: false, createdAt: new Date('2026-09-04T00:00:00Z') },
];

const base = { page: 1, pageSize: 100 };

describe('flatten', () => {
  it('exposes system fields under __ keys without touching business data', () => {
    const f = flatten(rows[0]!);
    expect(f.Name).toBe('Rahul');
    expect(f.__emailStatus).toBe('SENT');
    expect(f.__replyReceived).toBe(true);
    expect(f.__createdAt).toBe('2026-09-01T00:00:00.000Z');
    expect(flatten(rows[2]!).__emailStatus).toBe('NOT_SENT');
  });
});

describe('filter (shared with automations)', () => {
  it('applies an AND group over business fields', () => {
    const r = applyView(rows, { ...base, filter: { op: 'AND', rules: [{ field: 'Status', operator: 'equals', value: 'Ready' }, { field: 'Score', operator: 'is_not_empty' }] } });
    expect(r.records.map((x) => x.id)).toEqual(['a']);
    expect(r.matched).toBe(1);
  });

  it('filters on system email fields', () => {
    const r = applyView(rows, { ...base, filter: { op: 'OR', rules: [{ field: '__emailStatus', operator: 'equals', value: 'FAILED' }, { field: '__replyReceived', operator: 'equals', value: true }] } });
    expect(r.records.map((x) => x.id).sort()).toEqual(['a', 'b']);
  });

  it('an empty group matches everything', () => {
    expect(applyView(rows, { ...base, filter: { op: 'AND', rules: [] } }).matched).toBe(4);
  });
});

describe('search', () => {
  it('is a case-insensitive substring over every value', () => {
    expect(matchesSearch(flatten(rows[1]!), 'ANI')).toBe(true);
    expect(matchesSearch(flatten(rows[1]!), 'failed')).toBe(true);
    expect(matchesSearch(flatten(rows[1]!), 'rahul')).toBe(false);
    expect(applyView(rows, { ...base, search: '  ' }).matched).toBe(4);
  });

  it('combines with filter', () => {
    const r = applyView(rows, { ...base, search: 'ready', filter: { op: 'AND', rules: [{ field: 'Name', operator: 'contains', value: 'z' }] } });
    expect(r.records.map((x) => x.id)).toEqual(['c']);
  });
});

describe('sort', () => {
  it('sorts numerically when both sides are numbers, empties last', () => {
    expect(sortRecords(rows, [{ key: 'Score', dir: 'asc' }]).map((r) => r.id)).toEqual(['b', 'a', 'd', 'c']);
    expect(sortRecords(rows, [{ key: 'Score', dir: 'desc' }]).map((r) => r.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('sorts strings case-insensitively and dates lexically', () => {
    expect(sortRecords(rows, [{ key: 'Name', dir: 'asc' }]).map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(sortRecords(rows, [{ key: 'Deadline', dir: 'asc' }]).map((r) => r.id)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('applies secondary keys and sorts by system fields', () => {
    expect(sortRecords(rows, [{ key: 'Status', dir: 'asc' }, { key: 'Name', dir: 'desc' }]).map((r) => r.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(sortRecords(rows, [{ key: '__createdAt', dir: 'desc' }]).map((r) => r.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('compareValues treats null/empty as last in either direction of the pair', () => {
    expect(compareValues(null, 'x')).toBeGreaterThan(0);
    expect(compareValues('x', '')).toBeLessThan(0);
    expect(compareValues('', null)).toBe(0);
    expect(compareValues(true, false)).toBeGreaterThan(0);
  });
});

describe('group', () => {
  it('counts every matched record per group and orders pages by group', () => {
    const r = applyView(rows, { ...base, groupBy: 'Status', sort: [{ key: 'Name', dir: 'asc' }] });
    expect(r.groups).toEqual([
      { value: 'Pending', count: 1 },
      { value: 'Ready', count: 2 },
      { value: '', count: 1 },
    ]);
    expect(r.records.map((x) => x.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(r.groupOf).toEqual(['Pending', 'Ready', 'Ready', '']);
  });

  it('group counts reflect the filter, not the page', () => {
    const r = applyView(rows, { page: 1, pageSize: 1, groupBy: '__emailStatus' });
    expect(r.records).toHaveLength(1);
    expect(r.groups?.reduce((a, g) => a + g.count, 0)).toBe(4);
  });
});

describe('pagination', () => {
  it('slices after filter/sort and clamps the page', () => {
    const r = applyView(rows, { page: 2, pageSize: 3, sort: [{ key: 'Name', dir: 'asc' }] });
    expect(r.records.map((x) => x.id)).toEqual(['c']);
    expect(r.pageCount).toBe(2);
    expect(applyView(rows, { page: 99, pageSize: 3 }).page).toBe(2);
    expect(applyView([], base)).toMatchObject({ matched: 0, pageCount: 1, page: 1, groups: null, groupOf: null });
  });
});

describe('parseViewQuery / schema', () => {
  it('reads JSON filter and sort from the query string', () => {
    const q = parseViewQuery(new URLSearchParams({ filter: JSON.stringify({ op: 'AND', rules: [{ field: 'a', operator: 'equals', value: 1 }] }), sort: JSON.stringify([{ key: 'a', dir: 'desc' }]), search: 'x', groupBy: 'Status', page: '2', pageSize: '50' }));
    expect(q).toEqual({ filter: { op: 'AND', rules: [{ field: 'a', operator: 'equals', value: 1 }] }, sort: [{ key: 'a', dir: 'desc' }], search: 'x', groupBy: 'Status', page: 2, pageSize: 50 });
  });

  it('rejects malformed JSON, unknown operators, oversized pages and too many sorts', () => {
    expect(() => parseViewQuery(new URLSearchParams({ filter: '{nope' }))).toThrow();
    expect(() => viewQuerySchema.parse({ filter: { op: 'AND', rules: [{ field: 'a', operator: 'matches_regex' }] } })).toThrow();
    expect(() => viewQuerySchema.parse({ pageSize: 5000 })).toThrow();
    expect(() => viewQuerySchema.parse({ sort: [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }] })).toThrow();
  });

  it('accepts nested groups', () => {
    const nested = { op: 'AND', rules: [{ op: 'OR', rules: [{ field: 'a', operator: 'is_empty' }, { field: 'b', operator: 'is_empty' }] }] };
    expect(viewQuerySchema.parse({ filter: nested }).filter).toEqual(nested);
  });
});
