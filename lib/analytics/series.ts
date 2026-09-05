/**
 * Pure helpers for the §85/§127 charts. No database access here so the
 * bucketing logic is unit-testable and shared by the org and workspace
 * dashboards.
 */

export interface DayPoint {
  /** ISO date, YYYY-MM-DD, in the reporting timezone. */
  day: string;
  value: number;
}

const DEFAULT_TZ = 'Asia/Kolkata';

/** YYYY-MM-DD for `date` in `timeZone` (default IST — the org's timezone). */
export function dayKey(date: Date, timeZone = DEFAULT_TZ): string {
  // en-CA formats as YYYY-MM-DD, which sorts lexically.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** The `days` consecutive day keys ending today (inclusive). */
export function dayRange(days: number, now = new Date(), timeZone = DEFAULT_TZ): string[] {
  if (!Number.isInteger(days) || days <= 0) throw new Error('days must be a positive integer');
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(dayKey(new Date(now.getTime() - i * 86_400_000), timeZone));
  }
  return out;
}

/** Start of the window (UTC instant) that covers `days` days ending now. */
export function windowStart(days: number, now = new Date()): Date {
  // One extra day so a timezone offset never chops the first bucket.
  return new Date(now.getTime() - days * 86_400_000);
}

/**
 * Counts timestamps per day over a fixed range. Every day in the range is
 * present (zero-filled) so charts never have gaps; timestamps outside the
 * range are ignored rather than creating stray buckets.
 */
export function bucketByDay(
  timestamps: Iterable<Date | null | undefined>,
  days: number,
  now = new Date(),
  timeZone = DEFAULT_TZ
): DayPoint[] {
  const keys = dayRange(days, now, timeZone);
  const counts = new Map<string, number>(keys.map((k) => [k, 0]));
  for (const t of timestamps) {
    if (!t) continue;
    const k = dayKey(t, timeZone);
    if (counts.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return keys.map((day) => ({ day, value: counts.get(day) ?? 0 }));
}

export interface FailureRatePoint {
  day: string;
  sent: number;
  failed: number;
  /** 0–100, null when nothing was attempted that day (not 0 — see §117). */
  ratePct: number | null;
}

/** Per-day failure rate = failed / (sent + failed). */
export function failureRateByDay(sent: DayPoint[], failed: DayPoint[]): FailureRatePoint[] {
  const failedByDay = new Map(failed.map((p) => [p.day, p.value]));
  return sent.map((p) => {
    const f = failedByDay.get(p.day) ?? 0;
    const attempted = p.value + f;
    return {
      day: p.day,
      sent: p.value,
      failed: f,
      ratePct: attempted === 0 ? null : Math.round((f / attempted) * 1000) / 10,
    };
  });
}

/** Overall percentage with the same "null when nothing attempted" rule. */
export function overallFailurePct(sent: number, failed: number): number | null {
  const attempted = sent + failed;
  return attempted === 0 ? null : Math.round((failed / attempted) * 1000) / 10;
}
