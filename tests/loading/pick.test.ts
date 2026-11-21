import { describe, expect, it } from 'vitest';
import { cleanLine } from '@/lib/loading/clean';
import { EDTECH, PAGE_KEYS, PAGE_LABEL, PAGE_LINES, THOUGHTS, WORK, pageKeyOf } from '@/lib/loading/lines';
import { contextLine, emptyMemory, pickScreen, RECENT_THOUGHTS } from '@/lib/loading/pick';

/** A small deterministic random source, so a failure can be repeated. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe('the lines file', () => {
  it('has every page, with about eight lines each, and the shared pools', () => {
    for (const k of PAGE_KEYS) {
      expect(PAGE_LINES[k].length, k).toBeGreaterThanOrEqual(8);
      expect(PAGE_LABEL[k], k).toBeTruthy();
    }
    expect(EDTECH.length).toBeGreaterThanOrEqual(10);
    expect(WORK.length).toBeGreaterThanOrEqual(10);
    expect(THOUGHTS.length).toBeGreaterThanOrEqual(30);
  });
  it('every built-in line is short, plain, link-free and unique within its list', () => {
    const lists: Record<string, string[]> = { ...PAGE_LINES, EDTECH, WORK, THOUGHTS };
    for (const [name, list] of Object.entries(lists)) {
      const seen = new Set<string>();
      for (const line of list) {
        expect(line.length, `${name}: ${line}`).toBeLessThanOrEqual(90);
        expect(/@|https?:|www\.|<|>/.test(line), `${name}: ${line}`).toBe(false);
        // {{variables}} is the one place braces are fine: it is text about templates, not a template.
        expect(cleanLine(line.replace(/\{\{|\}\}/g, '')), `${name}: ${line}`).not.toBeNull();
        expect(seen.has(line.toLowerCase()), `${name} repeats: ${line}`).toBe(false);
        seen.add(line.toLowerCase());
      }
    }
  });
});

describe('pageKeyOf', () => {
  it('follows the route', () => {
    expect(pageKeyOf('/campaigns')).toBe('campaigns');
    expect(pageKeyOf('/campaigns/abc123')).toBe('campaigns');
    expect(pageKeyOf('/quick-send-follow-up/new')).toBe('send');
    expect(pageKeyOf('/recruiter-send/xyz')).toBe('recruiter');
    expect(pageKeyOf('/recruiter-follow-up')).toBe('recruiter');
    expect(pageKeyOf('/documents/library')).toBe('documents');
    expect(pageKeyOf('/settings/server')).toBe('settings');
    expect(pageKeyOf('/admin/users?x=1')).toBe('admin');
    expect(pageKeyOf('/login')).toBe('general');
    expect(pageKeyOf('/')).toBe('general');
    expect(pageKeyOf('/datasets')).toBe('general'); // not "/data"
  });
});

describe('pickScreen', () => {
  it('puts what the person is doing first, then the page lines, mixed with edtech and work lines', () => {
    const memory = emptyMemory();
    const { lines } = pickScreen({ key: 'contacts', context: ['Looking for “fintech”…', 'Narrowing it down to Pune…'], memory, rand: seeded(1) });
    expect(lines.slice(0, 2)).toEqual(['Looking for “fintech”…', 'Narrowing it down to Pune…']);
    expect(lines.some((l) => PAGE_LINES.contacts.includes(l))).toBe(true);
    expect(lines.some((l) => EDTECH.includes(l) || WORK.includes(l))).toBe(true);
    expect(new Set(lines).size).toBe(lines.length);
  });
  it('uses only this page’s lines, never another page’s', () => {
    const { lines } = pickScreen({ key: 'inbox', memory: emptyMemory(), rand: seeded(2) });
    const shared = new Set([...EDTECH, ...WORK, ...PAGE_LINES.inbox]);
    expect(lines.every((l) => shared.has(l))).toBe(true);
  });
  it('shows today’s fresh lines for the page before the built-in ones', () => {
    const daily = { date: '2026-11-20', pages: { inbox: ['Fresh one today', 'Fresh two today'] }, general: [], thoughts: [] };
    for (let seed = 1; seed <= 30; seed++) {
      const { lines } = pickScreen({ key: 'inbox', daily, memory: emptyMemory(), rand: seeded(seed) });
      const fresh = lines.filter((l) => l.startsWith('Fresh'));
      const firstBuiltIn = lines.findIndex((l) => PAGE_LINES.inbox.includes(l));
      expect(fresh).toHaveLength(2);
      expect(Math.max(...fresh.map((f) => lines.indexOf(f)))).toBeLessThan(firstBuiltIn);
    }
  });
  it('two visits in a row never open with the same line (any page, with or without the same search)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const memory = emptyMemory();
      const rand = seeded(seed);
      let previous = '';
      for (let visit = 0; visit < 12; visit++) {
        const key = PAGE_KEYS[visit % 3 === 0 ? 0 : 1]!; // alternate between two pages and repeat the first
        const { lines } = pickScreen({ key, context: visit % 2 ? ['Looking for “fintech”…'] : [], memory, rand });
        expect(lines[0], `seed ${seed} visit ${visit}`).not.toBe(previous);
        previous = lines[0]!;
      }
    }
  });
  it('the same page never opens with the line it opened with last time, even after other pages in between', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const memory = emptyMemory();
      const rand = seeded(seed);
      let lastReports = '';
      for (let visit = 0; visit < 10; visit++) {
        const r = pickScreen({ key: 'reports', memory, rand }).lines[0]!;
        expect(r).not.toBe(lastReports);
        lastReports = r;
        pickScreen({ key: 'inbox', memory, rand });
      }
    }
  });
  it('the thought avoids the last 4 shown', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const memory = emptyMemory();
      const rand = seeded(seed);
      const shown: string[] = [];
      for (let i = 0; i < 40; i++) {
        const { thought } = pickScreen({ key: 'history', memory, rand });
        expect(shown.slice(-RECENT_THOUGHTS), `seed ${seed} #${i}`).not.toContain(thought);
        shown.push(thought);
      }
    }
  });
  it('is different on every appearance, not a fixed order', () => {
    const openings = new Set<string>();
    const memory = emptyMemory();
    for (let i = 0; i < 20; i++) openings.add(pickScreen({ key: 'campaigns', memory, rand: seeded(i + 7) }).lines[0]!);
    expect(openings.size).toBeGreaterThan(5);
  });
});

describe('contextLine', () => {
  it('builds a line from the person’s words, cut short', () => {
    expect(contextLine('Looking for “{}”…', '  fintech  ')).toBe('Looking for “fintech”…');
    expect(contextLine('Looking for “{}”…', 'x'.repeat(100))!.length).toBeLessThan(60);
    expect(contextLine('Looking for “{}”…', '')).toBeNull();
    expect(contextLine('Looking for “{}”…', null)).toBeNull();
  });
});
