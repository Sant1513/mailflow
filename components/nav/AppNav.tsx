'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { NotificationBell } from '@/components/nav/NotificationBell';

const MAIN_ITEMS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/data', label: 'Data' },
  { href: '/contacts', label: 'Contacts' },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/templates', label: 'Templates' },
  { href: '/automations', label: 'Automations' },
  { href: '/batches', label: 'Batches' },
  { href: '/history', label: 'History' },
];

const REVIEWER_ITEMS = [{ href: '/approvals', label: 'Approvals' }];

const SETTINGS_ITEM = { href: '/settings', label: 'Settings' };

const ADMIN_ITEMS = [
  { href: '/admin/organization', label: 'Organization' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/workspaces', label: 'Workspaces' },
  { href: '/admin/all-data', label: 'All Data' },
  { href: '/admin/conversations', label: 'All Conversations' },
  { href: '/admin/audit-logs', label: 'Audit Logs' },
  { href: '/admin/system-settings', label: 'System Settings' },
];

function initials(name?: string | null, email?: string | null) {
  const source = (name?.trim() || email || '?').split('@')[0] ?? '?';
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const second = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (first + second).toUpperCase();
}

/**
 * Sidebar on ≥ lg; a top bar with a menu button and a slide-in drawer
 * below that (§133). Same links, same server-side gating — the nav only
 * decides what to show, never what is allowed.
 */
export function AppNav({
  user,
  pendingApprovals = 0,
}: {
  user: { name?: string | null; email?: string | null; image?: string | null; role: string };
  pendingApprovals?: number;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isSuperAdmin = user.role === 'SUPER_ADMIN';
  const isReviewer = isSuperAdmin || user.role === 'ADMIN';

  // Close the drawer on navigation and lock body scroll while it is open.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  const links = (
    <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
      {MAIN_ITEMS.map((item) => (
        <NavLink key={item.href} href={item.href} label={item.label} active={pathname?.startsWith(item.href)} />
      ))}

      {isReviewer && (
        <>
          <div className="my-3 border-t border-border-subtle" />
          {REVIEWER_ITEMS.map((item) => (
            <NavLink key={item.href} href={item.href} label={item.label} active={pathname?.startsWith(item.href)} badge={pendingApprovals} />
          ))}
        </>
      )}

      <div className="my-3 border-t border-border-subtle" />
      <NavLink href={SETTINGS_ITEM.href} label={SETTINGS_ITEM.label} active={pathname?.startsWith(SETTINGS_ITEM.href)} />

      {isSuperAdmin && (
        <>
          <div className="my-3 border-t border-border-subtle" />
          <div className="eyebrow px-3 pb-1 pt-1">Super Admin</div>
          {ADMIN_ITEMS.map((item) => (
            <NavLink key={item.href} href={item.href} label={item.label} active={pathname?.startsWith(item.href)} />
          ))}
        </>
      )}
    </nav>
  );

  const footer = (
    <div className="border-t border-border px-4 py-4">
      <div className="mb-3 flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 font-heading text-xs font-bold text-primary">
          {initials(user.name, user.email)}
        </div>
        <div className="min-w-0 text-xs">
          <div className="truncate font-medium text-foreground">{user.name ?? user.email}</div>
          <div className="truncate text-faint">{user.email}</div>
        </div>
      </div>
      <div className="mb-2">
        <NotificationBell />
      </div>
      <div className="mb-3">
        <ThemeToggle />
      </div>
      <button onClick={() => signOut({ callbackUrl: '/login' })} className="btn-secondary w-full !py-1.5 text-xs">
        Sign out
      </button>
    </div>
  );

  const wordmark = (
    <Link href="/dashboard" className="block">
      <div className="font-heading text-2xl font-bold leading-none tracking-tight text-foreground">
        masai<span className="text-primary">.</span>
      </div>
      <div className="eyebrow mt-2">MailFlow</div>
    </Link>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-card lg:flex">
        <div className="border-b border-border px-5 py-5">{wordmark}</div>
        {links}
        {footer}
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-card px-4 lg:hidden">
        <Link href="/dashboard" className="font-heading text-xl font-bold leading-none tracking-tight text-foreground">
          masai<span className="text-primary">.</span>
        </Link>
        <div className="flex items-center gap-2">
          <NotificationBell compact />
          <ThemeToggle compact />
          <button
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            aria-expanded={open}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-border text-foreground"
          >
            <span aria-hidden className="text-lg leading-none">☰</span>
          </button>
        </div>
      </header>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              {wordmark}
              <button onClick={() => setOpen(false)} aria-label="Close menu" className="flex h-9 w-9 items-center justify-center rounded-md border border-border text-foreground">
                ✕
              </button>
            </div>
            {links}
            {footer}
          </div>
        </div>
      )}
    </>
  );
}

function NavLink({ href, label, active, badge }: { href: string; label: string; active?: boolean; badge?: number }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`relative flex min-h-[36px] items-center justify-between rounded-md px-3 py-2 text-sm transition ${
        active
          ? 'bg-elevated font-medium text-foreground before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-0.5 before:rounded-full before:bg-primary'
          : 'text-muted-foreground hover:bg-elevated/60 hover:text-foreground'
      }`}
    >
      <span>{label}</span>
      {badge ? <span className="badge badge-warning !py-0">{badge}</span> : null}
    </Link>
  );
}
