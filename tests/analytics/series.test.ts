import { describe, it, expect } from 'vitest';
import {
  bucketByDay,
  dayKey,
  dayRange,
  failureRateByDay,
  overallFailurePct,
  windowStart,
} from '@/lib/analytics/series';

// 2026-09-05 12:00 IST == 06:30 UTC
const NOW = new Date('2026-09-05T06:30:00Z');

describe('dayKey', () => {
  it('formats in IST by default', () => {
    expect(dayKey(NOW)).toBe('2026-09-05');
    // 23:00 UTC on the 4th is already the 5th in IST (+05:30)
    expect(dayKey(new Date('2026-09-04T23:00:00Z'))).toBe('2026-09-05');
    expect(dayKey(new Date('2026-09-04T23:00:00Z'), 'UTC')).toBe('2026-09-04');
  });
});

describe('dayRange', () => {
  it('returns consecutive keys ending today', () => {
    expect(dayRange(3, NOW)).toEqual(['2026-09-03', '2026-09-04', '2026-09-05']);
  });

  it('crosses month boundaries', () => {
    expect(dayRange(2, new Date('2026-10-01T06:30:00Z'))).toEqual(['2026-09-30', '2026-10-01']);
  });

  it('rejects non-positive or fractional windows', () => {
    expect(() => dayRange(0, NOW)).toThrow();
    expect(() => dayRange(1.5, NOW)).toThrow();
  });
});

describe('bucketByDay', () => {
  it('zero-fills every day and counts within the window', () => {
    const points = bucketByDay(
      [
        new Date('2026-09-05T01:00:00Z'),
        new Date('2026-09-05T03:00:00Z'),
        new Date('2026-09-03T10:00:00Z'),
        null,
        undefined,
      ],
      3,
      NOW
    );
    expect(points).toEqual([
      { day: '2026-09-03', value: 1 },
      { day: '2026-09-04', value: 0 },
      { day: '2026-09-05', value: 2 },
    ]);
  });

  it('ignores timestamps outside the window instead of adding buckets', () => {
    const points = bucketByDay([new Date('2026-01-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z')], 2, NOW);
    expect(points.map((p) => p.value)).toEqual([0, 0]);
    expect(points).toHaveLength(2);
  });

  it('buckets by the reporting timezone, not UTC', () => {
    // 22:00 UTC on the 4th is 03:30 IST on the 5th.
    const points = bucketByDay([new Date('2026-09-04T22:00:00Z')], 2, NOW);
    expect(points).toEqual([
      { day: '2026-09-04', value: 0 },
      { day: '2026-09-05', value: 1 },
    ]);
  });
});

describe('failure rate', () => {
  it('is null (not 0) on days with nothing attempted', () => {
    const sent = [
      { day: 'd1', value: 0 },
      { day: 'd2', value: 9 },
      { day: 'd3', value: 3 },
    ];
    const failed = [
      { day: 'd2', value: 1 },
      { day: 'd3', value: 3 },
    ];
    expect(failureRateByDay(sent, failed)).toEqual([
      { day: 'd1', sent: 0, failed: 0, ratePct: null },
      { day: 'd2', sent: 9, failed: 1, ratePct: 10 },
      { day: 'd3', sent: 3, failed: 3, ratePct: 50 },
    ]);
  });

  it('rounds to one decimal', () => {
    expect(overallFailurePct(2, 1)).toBe(33.3);
    expect(overallFailurePct(0, 0)).toBeNull();
    expect(overallFailurePct(0, 4)).toBe(100);
  });
});

describe('windowStart', () => {
  it('covers the whole window', () => {
    expect(windowStart(30, NOW).getTime()).toBe(NOW.getTime() - 30 * 86_400_000);
  });
});
