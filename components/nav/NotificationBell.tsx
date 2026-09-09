'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

interface Item {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
}

const ICON: Record<string, string> = { NEW_REPLY: '↩', ASSIGNMENT: '👤', RESOLVED: '✓', FOLLOW_UP_DUE: '⏰', CAMPAIGN_APPROVAL: '✔', BATCH_FAILURE: '!' };

function ago(iso: string) {
  const m = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (m < 1) return 'now';
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

/** §87 notification centre: unread count, list, mark read. Polls every 60s. */
export function NotificationBell({ compact }: { compact?: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications?limit=20');
      if (!res.ok) return;
      const j = await res.json();
      setItems(j.notifications ?? []);
      setUnread(j.unread ?? 0);
    } catch {
      /* keep last state */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function markAll() {
    await fetch('/api/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
    load();
  }

  async function markOne(id: string) {
    await fetch('/api/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
    load();
  }

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        aria-expanded={open}
        className={`relative flex items-center gap-2 rounded-md border border-border text-foreground ${compact ? 'h-9 w-9 justify-center' : 'w-full px-3 py-2 text-sm hover:bg-elevated/60'}`}
      >
        <span aria-hidden>🔔</span>
        {!compact && <span className="text-muted-foreground">Notifications</span>}
        {unread > 0 && (
          <span className={`${compact ? 'absolute -right-1 -top-1' : 'ml-auto'} rounded-full bg-primary px-1.5 text-[10px] font-bold leading-4 text-primary-foreground`}>{unread > 99 ? '99+' : unread}</span>
        )}
      </button>
      {open && (
        <div className={`absolute z-40 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-md border border-border bg-card shadow-lg ${compact ? 'right-0' : 'left-0'}`}>
          <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2 text-xs">
            <span className="font-semibold">Notifications</span>
            {unread > 0 && <button onClick={markAll} className="text-muted-foreground hover:text-foreground">Mark all read</button>}
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {items.length === 0 && <li className="px-3 py-6 text-center text-xs text-muted-foreground">Nothing yet.</li>}
            {items.map((n) => (
              <li key={n.id} className={`border-b border-border-subtle text-xs ${n.read ? '' : 'bg-primary/5'}`}>
                <Link href={n.link ?? '#'} onClick={() => !n.read && markOne(n.id)} className="flex gap-2 px-3 py-2 hover:bg-elevated/60">
                  <span className="w-4 shrink-0 text-center">{ICON[n.type] ?? '•'}</span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate ${n.read ? '' : 'font-semibold'}`}>{n.title}</span>
                    {n.body && <span className="block truncate text-faint">{n.body}</span>}
                  </span>
                  <span className="shrink-0 text-faint">{ago(n.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
