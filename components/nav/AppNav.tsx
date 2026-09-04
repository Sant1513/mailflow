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

export function AppNav({
  user,
}: {
  user: { name?: string | null; email?: string | null; image?: string | null; role: string };
}) {
  const pathname = usePathname();
  const isSuperAdmin = user.role === 'SUPER_ADMIN';

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-card">
      <div className="border-b px-4 py-4">
        <div className="text-sm font-semibold">MailFlow</div>
        <div className="text-xs text-muted-foreground">Masai School</div>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        {MAIN_ITEMS.map((item) => (
          <NavLink key={item.href} href={item.href} label={item.label} active={pathname?.startsWith(item.href)} />
        ))}

        <div className="my-2 border-t" />
        <NavLink href={SETTINGS_ITEM.href} label={SETTINGS_ITEM.label} active={pathname?.startsWith(SETTINGS_ITEM.href)} />

        {isSuperAdmin && (
          <>
            <div className="my-2 border-t" />
            <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Super Admin
            </div>
            {ADMIN_ITEMS.map((item) => (
              <NavLink key={item.href} href={item.href} label={item.label} active={pathname?.startsWith(item.href)} />
            ))}
          </>
        )}
      </nav>

      <div className="border-t px-3 py-3">
        <div className="mb-2 truncate text-xs">
          <div className="font-medium">{user.name}</div>
          <div className="text-muted-foreground">{user.email}</div>
        </div>
        <button
          onClick={() => signOut({ callbackUrl: '/login' })}
          className="w-full rounded-md border px-2 py-1 text-xs hover:bg-muted"
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
      className={`block rounded-md px-3 py-1.5 text-sm ${
        active ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'
      }`}
    >
      {label}
    </Link>
  );
}
