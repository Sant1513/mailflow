import { describe, expect, it } from 'vitest';
import { cleanLine, cleanLines, dayKey, sanitizeDaily } from '@/lib/loading/clean';

describe('cleanLine', () => {
  it('keeps a plain line', () => {
    expect(cleanLine('Counting rows (all of them, no skipping)…')).toBe('Counting rows (all of them, no skipping)…');
  });
  it('strips tags and control characters', () => {
    expect(cleanLine('<b>Hello</b> there')).toBe('Hello there');
    expect(cleanLine('Hi\u0000 there​!')).toBe('Hi there !');
    expect(cleanLine('<script>alert(1)</script>Safe')).toBe('alert(1) Safe');
    expect(cleanLine('a < b > c')).toBe('a c'); // "< b >" reads as a tag and goes
  });
  it('drops anything over 90 characters', () => {
    expect(cleanLine('x'.repeat(90))).toBe('x'.repeat(90));
    expect(cleanLine('x'.repeat(91))).toBeNull();
    expect(cleanLine('x'.repeat(5000))).toBeNull();
  });
  it('drops links, mentions and scripts', () => {
    for (const bad of ['Visit https://evil.test now', 'see www.evil.test', 'go to evil.com', 'mail me at a@b.co', 'javascript:alert(1)', 'JaVaScRiPt:void(0)', '//cdn.evil/x.js', 'data:text/html,x', 'ping @everyone', 'learn.ai is great']) {
      expect(cleanLine(bad), bad).toBeNull();
    }
  });
  it('drops non-strings and empties', () => {
    for (const bad of [null, undefined, 3, {}, [], true, '', '   ', '<br>']) expect(cleanLine(bad as unknown)).toBeNull();
  });
});

describe('cleanLines', () => {
  it('removes repeats (any case), junk and caps the count', () => {
    const out = cleanLines(['One', 'one', ' ONE ', 'Two', 3, null, 'https://x.y', 'Three', 'Four'], 3);
    expect(out).toEqual(['One', 'Two', 'Three']);
  });
  it('anything that is not an array gives none', () => {
    expect(cleanLines('a,b,c', 5)).toEqual([]);
    expect(cleanLines({ 0: 'a' }, 5)).toEqual([]);
    expect(cleanLines(undefined, 5)).toEqual([]);
  });
});

describe('sanitizeDaily', () => {
  const good = { date: '2026-11-20', pages: { inbox: ['Opening the inbox…', 'Fetching replies…'], notAPage: ['x'] }, general: ['Hello there'], thoughts: ['Be kind.'] };
  it('keeps clean content and only known pages', () => {
    const d = sanitizeDaily(good)!;
    expect(d.date).toBe('2026-11-20');
    expect(d.pages.inbox).toHaveLength(2);
    expect(Object.keys(d.pages)).toEqual(['inbox']);
    expect(d.general).toEqual(['Hello there']);
  });
  it('rejects a bad or missing date, empties and non-objects', () => {
    expect(sanitizeDaily({ ...good, date: 'today' })).toBeNull();
    expect(sanitizeDaily({ ...good, date: undefined })).toBeNull();
    expect(sanitizeDaily({ date: '2026-11-20', pages: {}, general: [], thoughts: [] })).toBeNull();
    expect(sanitizeDaily('x')).toBeNull();
    expect(sanitizeDaily(null)).toBeNull();
  });
  it('caps the counts and cleans every line', () => {
    const many = Array.from({ length: 80 }, (_, i) => `Line number ${i}`);
    const d = sanitizeDaily({ date: '2026-11-20', pages: { inbox: [...many, '<i>x</i> https://bad.test'] }, thoughts: many, general: many })!;
    expect(d.pages.inbox).toHaveLength(12);
    expect(d.general).toHaveLength(14);
    expect(d.thoughts).toHaveLength(24);
  });
});

describe('dayKey', () => {
  it('is the India date', () => {
    expect(dayKey(Date.parse('2026-11-20T20:00:00Z'))).toBe('2026-11-21'); // 01:30 next day in India
    expect(dayKey(Date.parse('2026-11-20T10:00:00Z'))).toBe('2026-11-20');
  });
});
