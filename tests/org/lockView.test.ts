import { describe, expect, it } from 'vitest';
import { accessOf, parseUntilDate } from '@/lib/orgs/lifecycle';
import { isDashboardPath, lockViewFor } from '@/lib/orgs/lockView';

const NOW = new Date('2026-11-25T12:00:00+05:30');
const access = (over: { status?: string; until?: string | null; graceDays?: number } = {}) =>
  accessOf({ status: over.status ?? 'ACTIVE', validUntil: over.until === undefined ? null : over.until ? parseUntilDate(over.until) : null, graceDays: over.graceDays ?? 0 }, NOW);

describe('what a page shows for the organisation’s access', () => {
  it('an active organisation (or none) is left alone', () => {
    expect(lockViewFor(access(), '/campaigns', 'OPERATOR')).toBe('open');
    expect(lockViewFor(access({ until: '2027-06-30' }), '/campaigns', 'OPERATOR')).toBe('open');
    expect(lockViewFor(null, '/campaigns', 'OPERATOR')).toBe('open');
  });

  it('ending soon, or in its grace days: the page opens with a banner', () => {
    expect(lockViewFor(access({ until: '2026-12-05' }), '/campaigns', 'OPERATOR')).toBe('banner');
    expect(lockViewFor(access({ until: '2026-11-24', graceDays: 3 }), '/quick-send', 'ADMIN')).toBe('banner');
  });

  it('expired: only the Dashboard opens (with the banner); every other page is the lock screen', () => {
    const a = access({ until: '2026-11-20' });
    expect(a.state).toBe('EXPIRED');
    expect(lockViewFor(a, '/dashboard', 'OPERATOR')).toBe('dashboard-only');
    expect(lockViewFor(a, '/dashboard/', 'ADMIN')).toBe('dashboard-only');
    for (const p of ['/campaigns', '/quick-send', '/inbox', '/history', '/contacts', '/settings', '/recruiter-send/abc', '/admin/users', '/']) {
      expect(lockViewFor(a, p, 'OPERATOR'), p).toBe('locked');
    }
  });

  it('disabled: everything is the lock screen, the Dashboard too', () => {
    const a = access({ status: 'DISABLED' });
    expect(lockViewFor(a, '/dashboard', 'ADMIN')).toBe('locked');
    expect(lockViewFor(a, '/campaigns', 'OPERATOR')).toBe('locked');
  });

  it('a Super Admin is never locked, whatever their organisation', () => {
    expect(lockViewFor(access({ until: '2026-11-01' }), '/campaigns', 'SUPER_ADMIN')).toBe('open');
    expect(lockViewFor(access({ status: 'DISABLED' }), '/dashboard', 'SUPER_ADMIN')).toBe('open');
  });

  it('only /dashboard counts as the Dashboard (not a page that merely starts with it)', () => {
    expect(isDashboardPath('/dashboard')).toBe(true);
    expect(isDashboardPath('/dashboard/x')).toBe(true);
    expect(isDashboardPath('/dashboards')).toBe(false);
    expect(isDashboardPath('/admin/dashboard')).toBe(false);
  });
});
