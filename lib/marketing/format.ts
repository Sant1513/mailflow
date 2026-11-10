/**
 * Rounding for the public totals on the landing page. Pure and client-safe (the hero's
 * counters format their in-between values with it too).
 *
 * Always rounds DOWN, so the page never claims more than is true:
 *   7 -> "7", 128 -> "120+", 6,432 -> "6,400+", 12,950 -> "12k+", 1,260,000 -> "1.2M+".
 * Zero, negative or non-finite counts give null: the stat is hidden, never shown as 0.
 */
export type RoundedStat = { value: number; display: string };

export function roundDown(n: number): RoundedStat | null {
  if (!Number.isFinite(n) || n < 1) return null;
  const count = Math.floor(n);
  if (count < 100) return { value: count, display: String(count) };
  if (count < 1_000) {
    const v = Math.floor(count / 10) * 10;
    return { value: v, display: `${v}+` };
  }
  if (count < 10_000) {
    const v = Math.floor(count / 100) * 100;
    return { value: v, display: `${v.toLocaleString('en-US')}+` };
  }
  if (count < 1_000_000) {
    const k = Math.floor(count / 1_000);
    return { value: k * 1_000, display: `${k.toLocaleString('en-US')}k+` };
  }
  const m = Math.floor(count / 100_000) / 10;
  return { value: Math.round(m * 1_000_000), display: `${m}M+` };
}

/** Formats an in-between value of a count-up the same way as its final value (without the "+"). */
export function formatCounting(n: number, final: number): string {
  const v = Math.max(0, Math.floor(n));
  if (final >= 1_000_000) return `${(Math.floor(v / 100_000) / 10).toString()}M`;
  if (final >= 10_000) return `${Math.floor(v / 1_000).toLocaleString('en-US')}k`;
  return v.toLocaleString('en-US');
}
