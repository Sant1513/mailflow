'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronsLeft, ChevronsRight, LogOut, Menu, X } from 'lucide-react';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { NotificationBell } from '@/components/nav/NotificationBell';
import { ProductSwitcher } from '@/components/nav/ProductSwitcher';
import { FALLBACK_ICON, MAIL_GROUPS, NAV_ICON } from '@/components/nav/navMeta';
import { PRODUCT_NAV, PRODUCTS, activeNavHref, productForPath, type NavItem, type Product } from '@/lib/products';
import { rememberVisit } from '@/lib/products-client';

// Admins (ADMIN, SUPER_ADMIN): approvals, recruiter bulk sends and every mailbox's sending today.
export const REVIEWER_ITEMS: NavItem[] = [
  { href: '/approvals', label: 'Approvals' },
  { href: '/recruiter-send', label: 'Recruiter Bulk Send' },
  { href: '/mailbox-usage', label: 'Mailbox usage' },
];

export const SETTINGS_ITEM: NavItem = { href: '/settings', label: 'Settings' };

export const ADMIN_ITEMS: NavItem[] = [
  { href: '/admin/organization', label: 'Organization' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/workspaces', label: 'Workspaces' },
  { href: '/admin/all-data', label: 'All Data' },
  { href: '/admin/conversations', label: 'All Conversations' },
  { href: '/admin/audit-logs', label: 'Audit Logs' },
  { href: '/admin/system-settings', label: 'System Settings' },
];

const COLLAPSE_KEY = 'mailflow.nav.collapsed';

export function initials(name?: string | null, email?: string | null) {
  const source = (name?.trim() || email || '?').split('@')[0] ?? '?';
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const second = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (first + second).toUpperCase();
}

interface Group {
  label: string;
  items: (NavItem & { badge?: number })[];
}

/** The product's pages in groups (Mail has named groups; anything unlisted goes in "More"). */
function productGroups(product: Product, items: NavItem[]): Group[] {
  if (product !== 'mail') return [{ label: PRODUCTS[product].name, items }];
  const used = new Set<string>();
  const groups = MAIL_GROUPS.map((g) => ({
    label: g.label,
    items: g.hrefs.map((h) => items.find((i) => i.href === h)).filter((i): i is NavItem => !!i && !used.has(i.href) && (used.add(i.href), true)),
  })).filter((g) => g.items.length);
  const rest = items.filter((i) => !used.has(i.href));
  return rest.length ? [...groups, { label: 'More', items: rest }] : groups;
}

/**
 * Floating sidebar on ≥ lg (collapsible to an icon rail); a top bar with a slide-in drawer
 * below that (§133). Same links, same server-side gating — the nav only decides what to show,
 * never what is allowed.
 */
export function AppNav({
  user,
  pendingApprovals = 0,
  initialProduct = 'mail',
}: {
  user: { name?: string | null; email?: string | null; image?: string | null; role: string };
  pendingApprovals?: number;
  /** The product last used (from a cookie), for shared pages like Settings. */
  initialProduct?: Product;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const isSuperAdmin = user.role === 'SUPER_ADMIN';
  const isReviewer = isSuperAdmin || user.role === 'ADMIN';

  // Product pages decide the product; shared pages keep the one you came from.
  const [lastProduct, setLastProduct] = useState<Product>(initialProduct);
  const product = productForPath(pathname) ?? lastProduct;
  const productItems = PRODUCT_NAV[product];
  const groups: Group[] = [
    ...productGroups(product, productItems),
    // Only Approvals carries the pending count (it used to show on every admin item).
    ...(isReviewer ? [{ label: 'Admin', items: REVIEWER_ITEMS.map((i) => (i.href === '/approvals' ? { ...i, badge: pendingApprovals } : i)) }] : []),
    { label: 'Account', items: [SETTINGS_ITEM] },
    ...(isSuperAdmin ? [{ label: 'Super Admin', items: ADMIN_ITEMS }] : []),
  ];
  const activeHref = activeNavHref(pathname, groups.flatMap((g) => g.items));

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* private mode */
    }
  }, []);
  function toggleCollapsed() {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !c;
    });
  }

  // Close the drawer on navigation and lock body scroll while it is open.
  useEffect(() => {
    setOpen(false);
    const owner = productForPath(pathname);
    if (owner) setLastProduct(owner);
    if (pathname) rememberVisit(pathname + window.location.search);
  }, [pathname]);
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  const home = PRODUCTS[product].home;

  const links = (rail: boolean, pillId: string) => (
    <nav className={`flex-1 overflow-y-auto overflow-x-hidden ${rail ? 'px-2' : 'px-3'} py-2`} aria-label={`${PRODUCTS[product].name} navigation`}>
      {groups.map((g, gi) => (
        <div key={g.label} className={gi ? 'mt-4' : ''}>
          {rail ? (
            gi ? <div className="mx-auto mb-2 h-px w-6 bg-border" /> : null
          ) : (
            <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">{g.label}</div>
          )}
          <div className="space-y-0.5">
            {g.items.map((item) => (
              <NavLink key={item.href} item={item} active={activeHref === item.href} rail={rail} pillId={pillId} />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );

  const logo = (rail: boolean) => (
    <Link href={home} className="flex min-w-0 items-center gap-2.5" title="MailFlow home">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent-from to-accent-to font-heading text-base font-bold text-white shadow-card">m</span>
      {!rail && (
        <span className="min-w-0">
          <span className="block truncate font-heading text-[15px] font-bold leading-tight text-foreground">MailFlow</span>
          <span className="block truncate text-[11px] text-faint">{PRODUCTS[product].name} · masai.</span>
        </span>
      )}
    </Link>
  );

  return (
    <>
      {/* Desktop: floating sidebar / icon rail */}
      <motion.aside
        animate={{ width: collapsed ? 76 : 248 }}
        transition={{ type: 'spring', stiffness: 320, damping: 34 }}
        className="glass-nav sticky top-3 m-3 mr-0 hidden h-[calc(100dvh-1.5rem)] shrink-0 flex-col overflow-hidden rounded-3xl lg:flex"
      >
        <div className={`flex items-center ${collapsed ? 'justify-center px-2' : 'justify-between px-4'} pb-3 pt-4`}>
          {logo(collapsed)}
        </div>
        {!collapsed && (
          <div className="px-3 pb-2">
            <ProductSwitcher current={product} />
          </div>
        )}
        {links(collapsed, 'nav-pill-desktop')}
        <div className={`border-t border-border-subtle ${collapsed ? 'px-2' : 'px-3'} py-3`}>
          <button
            type="button"
            onClick={toggleCollapsed}
            className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs text-muted-foreground hover:bg-elevated hover:text-foreground ${collapsed ? 'justify-center' : ''}`}
            aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? <ChevronsRight size={16} /> : <><ChevronsLeft size={16} /> Collapse</>}
          </button>
        </div>
      </motion.aside>

      {/* Mobile top bar */}
      <header className="glass-nav sticky top-0 z-30 flex h-14 items-center justify-between gap-2 px-4 lg:hidden">
        <div className="flex min-w-0 items-center gap-3">
          {logo(true)}
          <div className="w-36 shrink-0">
            <ProductSwitcher current={product} compact />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <NotificationBell compact />
          <button
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            aria-expanded={open}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-foreground"
          >
            <Menu size={18} />
          </button>
        </div>
      </header>

      {/* Mobile drawer */}
      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
            <motion.div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            <motion.div
              className="glass-nav absolute inset-y-2 left-2 flex w-72 max-w-[85vw] flex-col overflow-hidden rounded-3xl"
              initial={{ x: -320, opacity: 0.6 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -320, opacity: 0.6 }}
              transition={{ type: 'spring', stiffness: 340, damping: 34 }}
            >
              <div className="flex items-center justify-between px-4 pb-3 pt-4">
                {logo(false)}
                <button onClick={() => setOpen(false)} aria-label="Close menu" className="flex h-9 w-9 items-center justify-center rounded-full border border-border text-foreground">
                  <X size={16} />
                </button>
              </div>
              <div className="px-3 pb-2">
                <ProductSwitcher current={product} />
              </div>
              {links(false, 'nav-pill-mobile')}
              <div className="space-y-2 border-t border-border-subtle px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent-from to-accent-to text-xs font-bold text-white">{initials(user.name, user.email)}</div>
                  <div className="min-w-0 text-xs">
                    <div className="truncate font-medium text-foreground">{user.name ?? user.email}</div>
                    <div className="truncate text-faint">{user.email}</div>
                  </div>
                </div>
                <ThemeToggle />
                <Link href="/choose" className="block text-center text-[11px] text-muted-foreground hover:text-foreground">Choose start product</Link>
                <button onClick={() => signOut({ callbackUrl: '/login' })} className="btn-secondary w-full !py-1.5 text-xs"><LogOut size={14} /> Sign out</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}

function NavLink({ item, active, rail, pillId }: { item: NavItem & { badge?: number }; active: boolean; rail: boolean; pillId: string }) {
  const Icon = NAV_ICON[item.href] ?? FALLBACK_ICON;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      title={rail ? item.label : undefined}
      className={`group relative flex min-h-[38px] items-center gap-3 rounded-xl text-sm ${rail ? 'justify-center px-0' : 'px-3'} ${
        active ? 'font-medium text-white' : 'text-muted-foreground hover:bg-elevated hover:text-foreground'
      }`}
    >
      {/* The active pill slides from item to item. */}
      {active && (
        <motion.span
          layoutId={pillId}
          className="nav-pill absolute inset-0 rounded-xl"
          transition={{ type: 'spring', stiffness: 420, damping: 36 }}
        />
      )}
      <Icon size={17} strokeWidth={active ? 2.2 : 1.8} className="relative shrink-0 transition-transform duration-200 group-hover:scale-110" />
      {!rail && <span className="relative min-w-0 flex-1 truncate">{item.label}</span>}
      {item.badge ? (
        <span className={`${rail ? 'absolute right-1 top-1 h-4 min-w-4 px-1 text-[9px]' : 'relative px-1.5 text-[10px]'} flex items-center justify-center rounded-full bg-gradient-to-br from-accent-from to-accent-to font-semibold text-white`}>
          {item.badge}
        </span>
      ) : null}
    </Link>
  );
}
