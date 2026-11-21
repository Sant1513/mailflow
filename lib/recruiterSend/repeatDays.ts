/** The repeat-guard window constants. Pure (no database), so client components can import them; recent.ts re-exports them. */
export const DEFAULT_REPEAT_DAYS = 10;
export const MAX_REPEAT_DAYS = 90;
/** Under this many days a recruiter send warns that people may feel over-mailed. */
export const SHORT_WINDOW_DAYS = 7;

/** The window to show or save: whole days, 0 (off) to 90; anything else falls back to 10. */
export function clampRepeatDays(days: number | null | undefined): number {
  if (days === null || days === undefined) return DEFAULT_REPEAT_DAYS;
  const n = Math.floor(Number(days));
  return Number.isFinite(n) ? Math.min(MAX_REPEAT_DAYS, Math.max(0, n)) : DEFAULT_REPEAT_DAYS;
}

/** The note shown under a window setting, or null when it is fine. */
export function windowWarning(days: number): string | null {
  if (days === 0) return 'The repeat check is off: nobody is skipped for being emailed recently.';
  if (days < SHORT_WINDOW_DAYS) return 'Under 7 days: recruiters may feel over-mailed, and a few days is often not enough for a reply.';
  return null;
}
