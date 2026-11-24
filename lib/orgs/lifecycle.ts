/**
 * Organisation lifecycle (spec: docs/org-lifecycle.md). Pure functions: the state of an organisation is always worked out from
 * its status, end date and grace days at the moment you ask; nothing is stored that could go stale.
 */

export type AccessState = 'ACTIVE' | 'EXPIRING' | 'GRACE' | 'EXPIRED' | 'DISABLED';
/** none: everything works · dashboard: only the Dashboard (read-only) · full: nothing at all. */
export type LockLevel = 'none' | 'dashboard' | 'full';

export interface OrgLifecycleFields {
  status: string;
  validUntil: Date | null;
  graceDays: number;
}

export interface OrgAccess {
  state: AccessState;
  lock: LockLevel;
  /** Whole days until the end date (0 = ends today, negative = already past); null with no expiry. */
  daysLeft: number | null;
  validUntil: Date | null;
  /** When the lock starts (end date + grace); null with no expiry. */
  locksAt: Date | null;
  /** Banner urgency while EXPIRING / GRACE: info (30-15 days), warning (14-8), urgent (7 or fewer, and expired). */
  level: 'info' | 'warning' | 'urgent' | null;
}

export const WARN_DAYS = 30;
/** Days left at which the Super Admins are reminded (each once). 0 = the day it ends. */
export const REMINDER_DAYS = [30, 14, 7, 3, 1, 0] as const;
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** The last instant (23:59:59.999 India time) of the calendar day (India) that contains `d`. */
export function endOfDayIST(d: Date): Date {
  const shifted = new Date(d.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 23, 59, 59, 999) - IST_OFFSET_MS);
}

/** Parses "YYYY-MM-DD" as that India date, ending at 23:59:59 IST. */
export function parseUntilDate(ymd: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const d = new Date(`${ymd}T12:00:00.000+05:30`);
  return Number.isNaN(d.getTime()) ? null : endOfDayIST(d);
}

/** Whole calendar days (India) from `now` to `end`: 0 when it ends today, 1 tomorrow, negative once past. */
function calendarDaysUntil(end: Date, now: Date): number {
  const a = Math.floor((end.getTime() + IST_OFFSET_MS) / DAY_MS);
  const b = Math.floor((now.getTime() + IST_OFFSET_MS) / DAY_MS);
  return a - b;
}

export function accessOf(org: OrgLifecycleFields, now: Date = new Date()): OrgAccess {
  if (org.status === 'DISABLED') return { state: 'DISABLED', lock: 'full', daysLeft: org.validUntil ? calendarDaysUntil(org.validUntil, now) : null, validUntil: org.validUntil, locksAt: null, level: 'urgent' };
  if (!org.validUntil) return { state: 'ACTIVE', lock: 'none', daysLeft: null, validUntil: null, locksAt: null, level: null };

  const daysLeft = calendarDaysUntil(org.validUntil, now);
  const locksAt = new Date(org.validUntil.getTime() + Math.max(0, org.graceDays) * DAY_MS);
  if (now.getTime() <= org.validUntil.getTime()) {
    if (daysLeft > WARN_DAYS) return { state: 'ACTIVE', lock: 'none', daysLeft, validUntil: org.validUntil, locksAt, level: null };
    return { state: 'EXPIRING', lock: 'none', daysLeft, validUntil: org.validUntil, locksAt, level: daysLeft <= 7 ? 'urgent' : daysLeft <= 14 ? 'warning' : 'info' };
  }
  if (now.getTime() <= locksAt.getTime()) return { state: 'GRACE', lock: 'none', daysLeft, validUntil: org.validUntil, locksAt, level: 'urgent' };
  return { state: 'EXPIRED', lock: 'dashboard', daysLeft, validUntil: org.validUntil, locksAt, level: 'urgent' };
}

/**
 * The new end date for an activation / extension.
 *   days: counted from today, or from the current end date when that is still in the future (renewing early loses nothing);
 *   until: that India date, to 23:59:59.
 * Returns null when the input is not usable (zero or negative days, a bad or past date).
 */
export function newValidUntil(input: { mode: 'days'; days: number } | { mode: 'until'; until: string }, current: Date | null, now: Date = new Date()): Date | null {
  if (input.mode === 'days') {
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > 3650) return null;
    const base = current && current.getTime() > now.getTime() ? current : now;
    return endOfDayIST(new Date(base.getTime() + input.days * DAY_MS));
  }
  const d = parseUntilDate(input.until);
  if (!d || d.getTime() <= now.getTime()) return null;
  return d;
}

export interface SeatStatus {
  used: number;
  limit: number | null;
  full: boolean;
  /** Seats left (null = unlimited). */
  left: number | null;
}

export function seatStatus(limit: number | null | undefined, used: number): SeatStatus {
  const lim = limit ?? null;
  return { used, limit: lim, full: lim !== null && used >= lim, left: lim === null ? null : Math.max(0, lim - used) };
}

/** The renewal reminder due now for an organisation, or null. Each threshold is sent once (`lastReminderDays` remembers it). */
export function reminderDue(org: OrgLifecycleFields & { lastReminderDays: number | null }, now: Date = new Date()): number | null {
  if (org.status === 'DISABLED' || !org.validUntil) return null;
  const days = calendarDaysUntil(org.validUntil, now);
  if (days < 0 || days > REMINDER_DAYS[0]) return null;
  // The smallest threshold that has been reached (e.g. 5 days left -> 7).
  const reached = [...REMINDER_DAYS].reverse().find((t) => days <= t);
  if (reached === undefined) return null;
  if (org.lastReminderDays !== null && org.lastReminderDays <= reached) return null;
  return reached;
}

/** The words for a banner / the lock screen. */
export function accessMessage(a: OrgAccess, orgName: string): { title: string; body: string } | null {
  const date = a.validUntil ? a.validUntil.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '';
  switch (a.state) {
    case 'EXPIRING':
      return { title: a.daysLeft === 0 ? `${orgName} ends today` : `${orgName} ends in ${a.daysLeft} day${a.daysLeft === 1 ? '' : 's'}`, body: `Access is valid until ${date}. Ask your admin to renew so nothing is interrupted.` };
    case 'GRACE':
      return { title: `${orgName} has expired`, body: `Access ended on ${date}. Everything locks on ${a.locksAt?.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}. Ask your admin to renew now.` };
    case 'EXPIRED':
      return { title: `${orgName}’s access has expired`, body: `Access ended on ${date}. Only the Dashboard can be viewed. Ask your admin to extend it by making the payment; everything is kept and comes back as soon as it is renewed.` };
    case 'DISABLED':
      return { title: `${orgName} is disabled`, body: 'This organisation has been disabled. Ask your admin to contact the MailFlow team to enable it again.' };
    default:
      return null;
  }
}
