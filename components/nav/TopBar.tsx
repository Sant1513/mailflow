'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, CornerDownLeft, LogOut, Monitor, Moon, Search, Sun, Repeat } from 'lucide-react';
import { NotificationBell } from '@/components/nav/NotificationBell';
import { ADMIN_ITEMS, REVIEWER_ITEMS, SETTINGS_ITEM, initials } from '@/components/nav/AppNav';
import { FALLBACK_ICON, NAV_ICON } from '@/components/nav/navMeta';
import { applyTheme, readTheme, THEME_KEY, type ThemePreference } from '@/components/theme/ThemeToggle';
import { PRODUCT_NAV, PRODUCTS, type NavItem, type Product } from '@/lib/products';

/**
 * Desktop top bar: search (⌘K / Ctrl+K opens a page finder), the light/dark switch, the
 * notification bell and the profile menu. Phones use the compact bar in AppNav instead.
 */
export function TopBar({ user }: { user: { name?: string | null; email?: string | null; role: string } }) {
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="sticky top-0 z-20 hidden px-3 pt-3 lg:block">
      <div className="glass-nav flex h-14 items-center gap-3 rounded-2xl px-3">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex h-9 min-w-0 max-w-md flex-1 items-center gap-2 rounded-full border border-border-subtle bg-muted px-3 text-left text-sm text-faint hover:border-border hover:text-muted-foreground"
        >
          <Search size={15} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">Search pages, campaigns, settings…</span>
          <kbd className="hidden shrink-0 rounded-md border border-border bg-card px-1.5 py-0.5 font-sans text-[10px] text-faint xl:inline">Ctrl K</kbd>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <ThemeSwitch />
          <NotificationBell compact />
          <ProfileMenu user={user} />
        </div>
      </div>
      <AnimatePresence>{paletteOpen && <CommandPalette role={user.role} onClose={() => setPaletteOpen(false)} />}</AnimatePresence>
    </div>
  );
}

/** Sun / moon switch with a sliding knob (the three-way System option is in the profile menu). */
export function ThemeSwitch() {
  const [pref, setPref] = useState<ThemePreference>('system');
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setPref(readTheme());
    setDark(document.documentElement.classList.contains('dark'));
  }, []);
  function choose(next: ThemePreference) {
    setPref(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode */
    }
    applyTheme(next);
    setDark(document.documentElement.classList.contains('dark'));
    window.dispatchEvent(new Event('mailflow-theme'));
  }
  useEffect(() => {
    const sync = () => {
      setPref(readTheme());
      setDark(document.documentElement.classList.contains('dark'));
    };
    window.addEventListener('mailflow-theme', sync);
    return () => window.removeEventListener('mailflow-theme', sync);
  }, []);
  return (
    <div className="relative flex h-9 items-center rounded-full border border-border-subtle bg-muted p-1" role="group" aria-label={`Theme (${pref})`}>
      {(['light', 'dark'] as const).map((t) => {
        const on = t === 'dark' ? dark : !dark;
        const Icon = t === 'dark' ? Moon : Sun;
        return (
          <button key={t} type="button" onClick={() => choose(t)} aria-pressed={on} title={t === 'dark' ? 'Dark' : 'Light'} className={`relative flex h-7 w-7 items-center justify-center rounded-full ${on ? 'text-ink-foreground' : 'text-faint hover:text-foreground'}`}>
            {on && <motion.span layoutId="theme-knob" className="absolute inset-0 rounded-full bg-ink shadow-card" transition={{ type: 'spring', stiffness: 500, damping: 34 }} />}
            <Icon size={14} className="relative" />
          </button>
        );
      })}
    </div>
  );
}

function ProfileMenu({ user }: { user: { name?: string | null; email?: string | null; role: string } }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  function matchSystem() {
    try {
      localStorage.setItem(THEME_KEY, 'system');
    } catch {
      /* ignore */
    }
    applyTheme('system');
    window.dispatchEvent(new Event('mailflow-theme'));
    setOpen(false);
  }
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex h-10 items-center gap-2 rounded-full border border-border-subtle bg-card py-1 pl-1 pr-3 hover:border-border">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-accent-from to-accent-to text-[11px] font-bold text-white">{initials(user.name, user.email)}</span>
        <span className="hidden min-w-0 text-left leading-tight xl:block">
          <span className="block max-w-[10rem] truncate text-xs font-semibold text-foreground">{user.name ?? user.email}</span>
          <span className="block max-w-[10rem] truncate text-[10px] text-faint">{user.email}</span>
        </span>
        <ChevronDown size={14} className={`text-faint transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.16 }}
            className="glass-nav absolute right-0 top-12 z-30 w-60 origin-top-right rounded-2xl p-1.5 text-sm"
          >
            <div className="px-3 py-2">
              <div className="truncate font-semibold text-foreground">{user.name ?? user.email}</div>
              <div className="truncate text-xs text-faint">{user.email} · {user.role.replace('_', ' ').toLowerCase()}</div>
            </div>
            <div className="my-1 h-px bg-border-subtle" />
            <button type="button" onClick={matchSystem} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-muted-foreground hover:bg-elevated hover:text-foreground"><Monitor size={15} /> Match system theme</button>
            <Link href="/choose" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-xl px-3 py-2 text-muted-foreground hover:bg-elevated hover:text-foreground"><Repeat size={15} /> Choose start product</Link>
            <button type="button" onClick={() => signOut({ callbackUrl: '/login' })} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-muted-foreground hover:bg-elevated hover:text-foreground"><LogOut size={15} /> Sign out</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Find any page: type to filter, ↑/↓ to move, Enter to open. */
function CommandPalette({ role, onClose }: { role: string; onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const reviewer = role === 'ADMIN' || role === 'SUPER_ADMIN';
  const all = useMemo(() => {
    const out: (NavItem & { group: string })[] = [];
    (Object.keys(PRODUCT_NAV) as Product[]).forEach((p) => PRODUCT_NAV[p].forEach((i) => out.push({ ...i, group: PRODUCTS[p].name })));
    if (reviewer) REVIEWER_ITEMS.forEach((i) => out.push({ ...i, group: 'Admin' }));
    out.push({ ...SETTINGS_ITEM, group: 'Account' });
    if (role === 'SUPER_ADMIN') ADMIN_ITEMS.forEach((i) => out.push({ ...i, group: 'Super Admin' }));
    return out;
  }, [reviewer, role]);
  const results = all.filter((i) => `${i.label} ${i.group}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 12);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setIndex(0), [q]);
  // Landing on another page (e.g. via a link) closes the finder.
  const firstPath = useRef(pathname);
  useEffect(() => {
    if (pathname !== firstPath.current) onClose();
  }, [pathname, onClose]);

  function go(href: string) {
    onClose();
    router.push(href);
  }

  return (
    <motion.div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        role="dialog"
        aria-label="Find a page"
        initial={{ opacity: 0, y: -10, scale: 0.97, filter: 'blur(6px)' }}
        animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
        exit={{ opacity: 0, y: -10, scale: 0.97 }}
        transition={{ duration: 0.22 }}
        className="glass-nav relative w-full max-w-lg overflow-hidden rounded-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border-subtle px-4">
          <Search size={16} className="text-faint" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(results.length - 1, i + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
              else if (e.key === 'Enter' && results[index]) go(results[index]!.href);
            }}
            placeholder="Go to…"
            className="h-12 flex-1 border-0 bg-transparent text-sm text-foreground outline-none focus:ring-0"
            aria-label="Search pages"
          />
          <kbd className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-faint">Esc</kbd>
        </div>
        <ul className="max-h-80 overflow-auto p-1.5">
          {results.map((r, i) => {
            const Icon = NAV_ICON[r.href] ?? FALLBACK_ICON;
            return (
              <li key={`${r.group}${r.href}`}>
                <button type="button" onMouseEnter={() => setIndex(i)} onClick={() => go(r.href)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm ${i === index ? 'bg-elevated text-foreground' : 'text-muted-foreground'}`}>
                  <Icon size={16} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{r.label}</span>
                  <span className="text-[11px] text-faint">{r.group}</span>
                  {i === index && <CornerDownLeft size={13} className="text-faint" />}
                </button>
              </li>
            );
          })}
          {!results.length && <li className="px-3 py-6 text-center text-sm text-faint">No page matches “{q}”.</li>}
        </ul>
      </motion.div>
    </motion.div>
  );
}
