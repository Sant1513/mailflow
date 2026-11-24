'use client';

import { usePathname } from 'next/navigation';
import { lockViewFor } from '@/lib/orgs/lockView';
import { OrgBanner } from '@/components/org/OrgBanner';
import { LockedScreen } from '@/components/org/LockedScreen';

export interface OrgGateInfo {
  orgId: string;
  orgName: string;
  state: 'ACTIVE' | 'EXPIRING' | 'GRACE' | 'EXPIRED' | 'DISABLED';
  lock: 'none' | 'dashboard' | 'full';
  level: 'info' | 'warning' | 'urgent' | null;
  daysLeft: number | null;
  title: string;
  body: string;
}

/**
 * Draws the renewal banner above a page, or the lock screen instead of it. It decides in the browser from the current address:
 * the layout around it does not redraw when someone moves from the Dashboard to another page, so a server-side decision would
 * go stale.
 */
export function OrgGate({ info, role, contacts, children }: { info: OrgGateInfo | null; role: string; contacts: { name: string; email: string }[]; children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const view = lockViewFor(info, pathname, role);
  if (!info) return <>{children}</>;
  if (view === 'locked') {
    return <LockedScreen orgName={info.orgName} state={info.state === 'DISABLED' ? 'DISABLED' : 'EXPIRED'} title={info.title} body={info.body} contacts={contacts} canViewDashboard={info.state === 'EXPIRED'} />;
  }
  return (
    <>
      {(view === 'banner' || view === 'dashboard-only') && info.level && <OrgBanner orgId={info.orgId} level={info.level} title={info.title} body={info.body} daysLeft={info.daysLeft} />}
      {children}
    </>
  );
}
