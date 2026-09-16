'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

interface Item {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
}

const ICON: Record<string, string> = {
  NEW_REPLY: '↩',
  ASSIGNMENT: '👤',
  RESOLVED: '✓',
  FOLLOW_UP_DUE: '⏰',
  CAMPAIGN_APPROVAL: '✔',
  BATCH_FAILURE: '!',
  USER_REGISTRATION: '🙋',
};
const ICON_COLOR: Record<string, string> = {
  NEW_REPLY: 'text-primary',
  BATCH_FAILURE: 'text-destructive',
  FOLLOW_UP_DUE: 'text-warning',
  USER_REGISTRATION: 'text-success',
};

function ago(iso: string) {
  const m = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (m < 1) return 'now';
  if (m < 60) return `${Math.round(m)}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400_000);
  if (d >= today) return 'Today';
  if (d >= yesterday) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** §87 notification centre: unread count, list, mark read.
 *
 * Sits in the sidebar header beside the wordmark.
 * In compact (mobile top-bar) mode opens downward-left.
 * When a new notification arrives it fires a 2-second sonner toast.
 */
export function NotificationBell({ compact }: { compact?: boolean }) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const prevIdsRef = useRef<Set<string>>(new Set());
  const initialLoadRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications?limit=25');
      if (!res.ok) return;
      const j = await res.json();
      const newItems: Item[] = j.notifications ?? [];
      const newUnread: number = j.unread ?? 0;

      // Detect genuinely new (never-seen) unread notifications after the first load.
      if (!initialLoadRef.current) {
        const fresh = newItems.filter((n) => !n.read && !prevIdsRef.current.has(n.id));
        if (fresh.length > 0) {
          const latest = fresh[0]!;
          toast(latest.title, {
            description: latest.body ?? undefined,
            duration: 2000,
            ...(latest.link
              ? {
                  action: {
                    label: 'View',
                    onClick: () => router.push(latest.link!),
                  },
                }
              : {}),
          });
        }
      }
      initialLoadRef.current = false;
      prevIdsRef.current = new Set(newItems.map((n) => n.id));

      setItems(newItems);
      setUnread(newUnread);
    } catch {
      /* keep last state */
    }
  }, [router]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function togglePanel() {
    if (open) { setOpen(false); return; }
    if (!btnRef.current) { setOpen(true); return; }
    const r = btnRef.current.getBoundingClientRect();
    const panelW = Math.min(352, window.innerWidth - 16);
    let left: number;
    if (compact) {
      // Mobile top-bar: right-align to the bell button, clamped to screen.
      left = Math.max(8, r.right - panelW);
    } else {
      // Sidebar: open to the RIGHT of the bell, just past the sidebar edge.
      left = Math.min(r.right + 4, window.innerWidth - panelW - 8);
    }
    setPanelPos({ top: r.bottom + 8, left });
    setOpen(true);
  }

  async function markAll() {
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    load();
  }

  async function markOne(id: string) {
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    load();
  }

  // Group items by date label.
  const groups: { label: string; items: Item[] }[] = [];
  for (const item of items) {
    const label = dateLabel(item.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.items.push(item);
    } else {
      groups.push({ label, items: [item] });
    }
  }

  return (
    <div ref={box} className="relative">
      {/* Trigger button */}
      <button
        ref={btnRef}
        onClick={togglePanel}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        aria-expanded={open}
        className={`relative flex items-center justify-center rounded-md border border-border text-foreground hover:bg-elevated/60 ${
          compact ? 'h-9 w-9' : 'h-8 w-8'
        } ${open ? 'bg-elevated/60' : ''}`}
      >
        <span aria-hidden className="text-base leading-none">🔔</span>
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 rounded-full bg-primary px-1.5 text-[10px] font-bold leading-4 text-primary-foreground">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {/* Panel — fixed so it's always fully on-screen regardless of where the bell sits. */}
      {open && panelPos && (
        <div
          style={{
            position: 'fixed',
            top: panelPos.top,
            left: panelPos.left,
            width: `min(22rem, calc(100vw - 1rem))`,
            maxHeight: 'min(28rem, calc(100dvh - 5rem))',
          }}
          className="z-[200] overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">Notifications</span>
              {unread > 0 && (
                <span className="rounded-full bg-primary px-1.5 text-[10px] font-bold leading-4 text-primary-foreground">
                  {unread}
                </span>
              )}
            </div>
            {unread > 0 && (
              <button
                onClick={markAll}
                className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-elevated hover:text-foreground"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div className="overflow-y-auto" style={{ maxHeight: 'min(20rem, calc(100dvh - 9rem))' }}>
            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <span className="text-2xl">🔔</span>
                <p className="text-sm text-muted-foreground">You&apos;re all caught up!</p>
                <p className="text-xs text-faint">Replies, assignments and follow-ups appear here.</p>
              </div>
            ) : (
              groups.map(({ label, items: gItems }) => (
                <div key={label}>
                  <div className="sticky top-0 bg-muted px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {label}
                  </div>
                  {gItems.map((n) => (
                    <Link
                      key={n.id}
                      href={n.link ?? '#'}
                      onClick={() => {
                        if (!n.read) markOne(n.id);
                        setOpen(false);
                      }}
                      className={`flex gap-3 border-b border-border-subtle px-4 py-2.5 hover:bg-elevated/60 ${
                        n.read ? '' : 'bg-primary/5'
                      }`}
                    >
                      {/* Icon */}
                      <div
                        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
                          n.read ? 'bg-muted text-muted-foreground' : 'bg-primary/15 text-primary'
                        } ${ICON_COLOR[n.type] ?? ''}`}
                      >
                        {ICON[n.type] ?? '•'}
                      </div>

                      {/* Content */}
                      <div className="min-w-0 flex-1">
                        <p className={`text-xs leading-snug ${n.read ? 'text-muted-foreground' : 'font-semibold text-foreground'}`}>
                          {n.title}
                        </p>
                        {n.body && (
                          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-faint">{n.body}</p>
                        )}
                        <p className="mt-1 text-[10px] text-faint">{ago(n.createdAt)}</p>
                      </div>

                      {/* Unread dot */}
                      {!n.read && (
                        <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                      )}
                    </Link>
                  ))}
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          {items.length > 0 && (
            <div className="border-t border-border-subtle px-4 py-2 text-center">
              <span className="text-[11px] text-faint">{items.length} notification{items.length !== 1 ? 's' : ''} shown</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
