import { describe, expect, it } from 'vitest';
import { estimateRemaining, formatCountdown, formatDuration, formatIst } from '@/lib/recruiterSend/eta';

/** Time left for a running send comes from its real pace, never from the pause setting. */
const at = (iso: string) => new Date(iso);
const started = '2026-11-13T05:52:00Z';

describe('estimateRemaining', () => {
  it('uses the last 10 minutes: 127 sent in 10 min, 1,561 to go → about 123 min', () => {
    const e = estimateRemaining({ remaining: 1561, sentLast10Min: 127, sentTotal: 1347, startedAt: started, now: at('2026-11-13T07:38:00Z') });
    expect(e.basis).toBe('recent');
    expect(e.ratePerMin).toBeCloseTo(12.7, 1);
    expect(Math.round((e.ms ?? 0) / 60_000)).toBe(123);
  });
  it('is done when nothing remains', () => {
    expect(estimateRemaining({ remaining: 0, sentLast10Min: 0, sentTotal: 100, startedAt: started, now: at('2026-11-13T08:00:00Z') })).toEqual({ ms: 0, basis: 'done', ratePerMin: null });
  });
  it('says waiting (no number) when nothing went out for 10 minutes', () => {
    const e = estimateRemaining({ remaining: 500, sentLast10Min: 0, sentTotal: 900, startedAt: started, now: at('2026-11-13T07:38:00Z') });
    expect(e).toEqual({ ms: null, basis: 'waiting', ratePerMin: null });
  });
  it('right after the start it uses the average, then "calculating" before there is anything to go on', () => {
    const early = estimateRemaining({ remaining: 90, sentLast10Min: 2, sentTotal: 2, startedAt: started, now: at('2026-11-13T05:52:30Z') });
    expect(early.basis).toBe('calculating');
    const soon = estimateRemaining({ remaining: 100, sentLast10Min: 2, sentTotal: 2, startedAt: started, now: at('2026-11-13T05:54:00Z') });
    expect(soon.basis).toBe('calculating'); // fewer than 3 sent
    const avg = estimateRemaining({ remaining: 100, sentLast10Min: 2, sentTotal: 4, startedAt: started, now: at('2026-11-13T05:54:00Z') });
    expect(avg.basis).toBe('average');
    expect(Math.round((avg.ms ?? 0) / 60_000)).toBe(50);
  });
  it('a send that started 2 minutes ago uses a 2-minute window, not 10', () => {
    const e = estimateRemaining({ remaining: 200, sentLast10Min: 40, sentTotal: 40, startedAt: started, now: at('2026-11-13T05:54:00Z') });
    expect(e.ratePerMin).toBeCloseTo(20, 5);
    expect(Math.round((e.ms ?? 0) / 60_000)).toBe(10);
  });
});

describe('formatting', () => {
  it('durations and countdowns', () => {
    expect(formatDuration(123 * 60_000)).toBe('2 h 03 min');
    expect(formatDuration(42 * 60_000)).toBe('42 min');
    expect(formatDuration(35_000)).toBe('35 s');
    expect(formatCountdown(6730_000)).toBe('1:52:10');
    expect(formatCountdown(2525_000)).toBe('42:05');
    expect(formatCountdown(-5)).toBe('0:00');
  });
  it('times are shown in India time', () => {
    expect(formatIst('2026-11-13T05:52:00Z')).toMatch(/13 Nov 2026, 11:22/i);
    expect(formatIst(null)).toBe('—');
    expect(formatIst('not a date')).toBe('—');
  });
});
