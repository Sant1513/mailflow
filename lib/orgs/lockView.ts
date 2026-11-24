import type { OrgAccess } from '@/lib/orgs/lifecycle';

/**
 * What a page shows for a signed-in person, given their organisation's access (lib/orgs/lifecycle.ts) and the page they asked for.
 *   open            nothing special
 *   banner          the page as normal, with the renewal banner above it (expiring, or expired but still in grace)
 *   dashboard-only  expired: this page is the Dashboard, so it opens, with the red banner (the APIs refuse writes)
 *   locked          the lock screen instead of the page
 * Super Admins (they run the platform) and people with no organisation are never locked.
 */
export type LockView = 'open' | 'banner' | 'dashboard-only' | 'locked';

export const isDashboardPath = (pathname: string) => pathname === '/dashboard' || pathname.startsWith('/dashboard/');

/** Only what the decision needs, so it can run in the browser too (a layout does not redraw when you move between pages). */
export type AccessForView = Pick<OrgAccess, 'state' | 'lock'>;

export function lockViewFor(access: AccessForView | null, pathname: string, role: string): LockView {
  if (!access || role === 'SUPER_ADMIN') return 'open';
  if (access.lock === 'full') return 'locked';
  if (access.lock === 'dashboard') return isDashboardPath(pathname) ? 'dashboard-only' : 'locked';
  return access.state === 'EXPIRING' || access.state === 'GRACE' ? 'banner' : 'open';
}
