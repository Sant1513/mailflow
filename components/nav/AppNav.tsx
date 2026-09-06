'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';

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

export function AppNav({
  user,
}: {
  user: { name?: string | null; email?: string | null; image?: string | null; role: string };
}) {
  const pathname = usePathname();
  const isSuperAdmin = user.role === 'SUPER_ADMIN';

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card">
      {/* Wordmark — mirrors the masaischool.com "masai." lockup */}
      <div className="border-b border-border px-5 py-5">
        <Link href="/dashboard" className="block">
          <div className="font-heading text-2xl font-bold leading-none tracking-tight text-foreground">
            masai<span className="text-primary">.</span>
          </div>
          <div className="eyebrow mt-2">MailFlow</div>
        </Link>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
        {MAIN_ITEMS.map((item) => (
          <NavLink key={item.href} href={item.href} label={item.label} active={pathname?.startsWith(item.href)} />
        ))}

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
        <button
          onClick={() => signOut({ callbackUrl: '/login' })}
          className="btn-secondary w-full !py-1.5 text-xs"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}

function NavLink({ href, label, active }: { href: string; label: string; active?: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`relative block rounded-md px-3 py-2 text-sm transition ${
        active
          ? 'bg-elevated font-medium text-foreground before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-0.5 before:rounded-full before:bg-primary'
          : 'text-muted-foreground hover:bg-elevated/60 hover:text-foreground'
      }`}
    >
      {label}
    </Link>
  );
}
