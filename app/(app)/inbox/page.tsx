'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';

interface InboxRow {
  id: string;
  subject: string;
  status: string;
  unread: boolean;
  lastMessageAt: string | null;
  messageCount: number;
  contact: { id: string; name: string | null; primaryEmail: string } | null;
  recipientEmail: string;
  assignee: { id: string; name: string } | null;
  tags: { name: string; color: string | null }[];
  lastMessage: { snippet: string | null; direction: string; classification: string; senderName: string | null } | null;
}

const FILTERS: { key: string; label: string; countKey?: 'unread' | 'mine' | 'open' | 'waiting' }[] = [
  { key: 'unread', label: 'Unread', countKey: 'unread' },
  { key: 'mine', label: 'Assigned to me', countKey: 'mine' },
  { key: 'open', label: 'Open', countKey: 'open' },
  { key: 'waiting', label: 'Waiting for student', countKey: 'waiting' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'all', label: 'All' },
];

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}

/** §51/§109 Inbox: filter rail + conversation list. */
export default function InboxPage() {
  const [filter, setFilter] = useState('open');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [gmail, setGmail] = useState<{ connected: boolean; pushConfigured: boolean; email?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ filter });
    if (q.trim()) params.set('q', q.trim());
    const res = await fetch(`/api/inbox?${params}`);
    const json = await res.json();
    setRows(json.conversations ?? []);
    setCounts(json.counts ?? {});
    setLoading(false);
  }, [filter, q]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  useEffect(() => {
    fetch('/api/gmail/sync')
      .then((r) => r.json())
      .then((j) =>
        setGmail({
          connected: j.account?.status === 'CONNECTED',
          pushConfigured: !!j.pushConfigured,
          email: j.account?.emailAddress,
        })
      )
      .catch(() => setGmail({ connected: false, pushConfigured: false }));
  }, []);

  async function syncNow() {
    setSyncing(true);
    const res = await fetch('/api/gmail/sync', { method: 'POST' });
    const json = await res.json();
    setSyncing(false);
    if (!res.ok) {
      toast.error(json.error ?? 'Sync failed');
      return;
    }
    toast.success(json.note ?? 'Synced');
    load();
  }

  return (
    <div className="flex h-screen">
      {/* LEFT: filters */}
      <aside className="w-56 shrink-0 border-r bg-card p-3">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-sm font-semibold">Inbox</h1>
          <button
            onClick={syncNow}
            disabled={syncing || gmail?.connected === false}
            title={gmail?.connected === false ? 'Connect Gmail in Settings first' : 'Pull new replies from Gmail'}
            className="rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>

        <nav className="space-y-0.5">
          {FILTERS.map((f) => {
            const n = f.countKey ? counts[f.countKey] : undefined;
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm ${
                  filter === f.key ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                }`}
              >
                <span>{f.label}</span>
                {n !== undefined && n > 0 && (
                  <span className={`rounded-full px-1.5 text-[11px] ${filter === f.key ? 'bg-white/20' : 'bg-muted'}`}>{n}</span>
                )}
              </button>
            );
          })}
        </nav>

        {gmail && (
          <div className="mt-4 rounded-md border bg-muted/40 p-2 text-[11px] text-muted-foreground">
            {gmail.connected ? (
              <>
                <div className="truncate">Syncing {gmail.email}</div>
                <div className="mt-0.5">
                  {gmail.pushConfigured ? 'Live push enabled' : 'Manual sync only — set GMAIL_PUBSUB_TOPIC for live push.'}
                </div>
              </>
            ) : (
              <div>
                No Gmail connected.{' '}
                <Link href="/settings" className="underline">Connect</Link> to receive replies.
              </div>
            )}
          </div>
        )}
      </aside>

      {/* CENTER: list */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b bg-card px-4 py-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email, subject, message text, or thread id…"
            className="w-full max-w-xl rounded-md border px-3 py-1.5 text-sm"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="p-12 text-center text-sm text-muted-foreground">
              {filter === 'unread' ? "You're all caught up." : 'No conversations yet.'}
              {gmail?.connected && filter !== 'unread' && (
                <div className="mt-2 text-xs">Replies appear here after a sync. Try &quot;Sync now&quot;.</div>
              )}
            </div>
          ) : (
            <ul>
              {rows.map((c) => (
                <li key={c.id} className="border-b">
                  <Link
                    href={`/inbox/${c.id}`}
                    className={`block px-4 py-3 hover:bg-muted/50 ${c.unread ? 'bg-primary/5' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          {c.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" title="Unread reply" />}
                          <span className={`truncate text-sm ${c.unread ? 'font-semibold' : 'font-medium'}`}>
                            {c.contact?.name || c.recipientEmail}
                          </span>
                          {c.assignee && (
                            <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                              {c.assignee.name}
                            </span>
                          )}
                        </div>
                        <div className="truncate text-sm">{c.subject}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {c.lastMessage?.direction === 'OUTBOUND' && <span className="mr-1">You:</span>}
                          {c.lastMessage?.classification && c.lastMessage.classification !== 'HUMAN_REPLY' && (
                            <span className="mr-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800">
                              {c.lastMessage.classification.replace(/_/g, ' ').toLowerCase()}
                            </span>
                          )}
                          {c.lastMessage?.snippet ?? ''}
                        </div>
                        {c.tags.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {c.tags.map((t) => (
                              <span key={t.name} className="rounded px-1.5 text-[10px]" style={{ background: t.color ? `${t.color}22` : undefined, color: t.color ?? undefined }}>
                                {t.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 text-right text-xs text-muted-foreground">
                        <div>{timeAgo(c.lastMessageAt)}</div>
                        <div className="mt-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px]">
                          {c.status.replace(/_/g, ' ').toLowerCase()}
                        </div>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
