'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useAutoSync } from '@/components/inbox/useAutoSync';

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
  firstMessageDirection: string | null;
}

const FILTERS: { key: string; label: string; countKey?: 'unread' | 'mine' | 'open' | 'waiting' }[] = [
  { key: 'unread', label: 'Unread', countKey: 'unread' },
  { key: 'mine', label: 'Assigned to me', countKey: 'mine' },
  { key: 'open', label: 'Open', countKey: 'open' },
  { key: 'waiting', label: 'Waiting for student', countKey: 'waiting' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'all', label: 'All' },
];

const PAGE_SIZE = 40;

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

/** §51/§109 Inbox: filter rail + conversation list with bulk actions. */
export default function InboxPage() {
  const [filter, setFilter] = useState('open');
  const [q, setQ] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [tag, setTag] = useState('');
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [gmail, setGmail] = useState<{ connected: boolean; pushConfigured: boolean; email?: string } | null>(null);
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);

  // Bulk selection state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkAssignee, setBulkAssignee] = useState('');
  const [bulkTag, setBulkTag] = useState('');
  const tagInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (p = page) => {
    setLoading(true);
    const params = new URLSearchParams({ filter, page: String(p), pageSize: String(PAGE_SIZE) });
    if (q.trim()) params.set('q', q.trim());
    if (assigneeId) params.set('assigneeId', assigneeId);
    if (tag.trim()) params.set('tag', tag.trim());
    const res = await fetch(`/api/inbox?${params}`);
    const json = await res.json();
    setRows(json.conversations ?? []);
    setCounts(json.counts ?? {});
    setTotal(json.total ?? 0);
    setLoading(false);
    setSelected(new Set()); // clear selection on reload
  }, [filter, q, page, assigneeId, tag]);

  useEffect(() => {
    fetch('/api/members')
      .then((r) => r.json())
      .then((j) => setMembers(j.members ?? []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setPage(1);
    const t = setTimeout(() => load(1), q ? 250 : 0);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, q, assigneeId, tag]);

  useEffect(() => { load(page); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  useAutoSync(() => load(page));

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
    if (!res.ok) { toast.error(json.error ?? 'Sync failed'); return; }
    toast.success(json.note ?? 'Synced');
    load(page);
  }

  // ── Bulk selection ──────────────────────────────────────────────────────
  const allIds = rows.map((r) => r.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0;

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allIds));
  }

  async function bulkAction(action: string, extra?: Record<string, string | null>) {
    if (!selected.size) return;
    setBulkBusy(true);
    const res = await fetch('/api/inbox/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selected], action, ...extra }),
    });
    setBulkBusy(false);
    const json = await res.json();
    if (!res.ok) { toast.error(json.error ?? 'Action failed'); return; }
    toast.success(`${json.updated} conversation${json.updated !== 1 ? 's' : ''} updated.`);
    setBulkAssignee('');
    setBulkTag('');
    load(page);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex h-full min-h-[calc(100dvh-3.5rem)] lg:min-h-0">
      {/* LEFT: filters */}
      <aside className="w-56 shrink-0 border-r bg-card p-3">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-sm font-semibold">Inbox</h1>
          <button
            onClick={syncNow}
            disabled={syncing || gmail?.connected === false}
            title={gmail?.connected === false ? 'Connect Gmail in Settings first' : 'Pull new replies from Gmail'}
            className="rounded border px-2 py-1 text-xs hover:bg-elevated disabled:opacity-50"
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
                  filter === f.key ? 'bg-primary text-primary-foreground' : 'hover:bg-elevated'
                }`}
              >
                <span>{f.label}</span>
                {n !== undefined && n > 0 && (
                  <span className={`rounded-full px-1.5 text-[11px] ${filter === f.key ? 'bg-card/20' : 'bg-muted'}`}>{n}</span>
                )}
              </button>
            );
          })}
        </nav>

        {members.length > 0 && (
          <div className="mt-4">
            <div className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Assignee</div>
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className="w-full rounded border bg-background px-2 py-1 text-xs">
              <option value="">All</option>
              <option value="none">Unassigned</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        )}

        <div className="mt-3">
          <div className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Tag</div>
          <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Filter by tag…"
            className="w-full rounded border bg-background px-2 py-1 text-xs" />
        </div>

        {(assigneeId || tag) && (
          <button onClick={() => { setAssigneeId(''); setTag(''); }}
            className="mt-2 w-full rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-elevated">
            Clear filters
          </button>
        )}

        {gmail && (
          <div className="mt-4 rounded-md border bg-muted/40 p-2 text-[11px] text-muted-foreground">
            {gmail.connected ? (
              <>
                <div className="truncate">Syncing {gmail.email}</div>
                <div className="mt-0.5">{gmail.pushConfigured ? 'Live push enabled' : 'Manual sync only.'}</div>
              </>
            ) : (
              <div>No Gmail connected. <Link href="/settings" className="underline">Connect</Link></div>
            )}
          </div>
        )}
        <div className="mt-4 rounded-md border bg-muted/40 p-2 text-[11px] text-muted-foreground">
          <p className="font-medium text-foreground">What shows here</p>
          <p className="mt-0.5">Only threads started by MailFlow campaigns or replied to via MailFlow.</p>
        </div>
      </aside>

      {/* CENTER: list */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b bg-card px-4 py-2">
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email, subject, message text, or thread id…"
            className="min-w-0 flex-1 btn-secondary" />
          {total > 0 && !loading && (
            <span className="shrink-0 text-xs text-muted-foreground">{total} conversation{total !== 1 ? 's' : ''}</span>
          )}
        </div>

        {/* Bulk actions toolbar */}
        {someSelected && (
          <div className="flex flex-wrap items-center gap-2 border-b bg-elevated/60 px-4 py-2">
            <span className="text-xs font-medium">{selected.size} selected</span>
            <button onClick={() => bulkAction('resolve')} disabled={bulkBusy}
              className="rounded border px-2 py-1 text-xs hover:bg-card">✓ Resolve</button>
            <button onClick={() => bulkAction('reopen')} disabled={bulkBusy}
              className="rounded border px-2 py-1 text-xs hover:bg-card">↩ Reopen</button>
            <button onClick={() => bulkAction('mark_read')} disabled={bulkBusy}
              className="rounded border px-2 py-1 text-xs hover:bg-card">Mark read</button>
            <button onClick={() => bulkAction('mark_unread')} disabled={bulkBusy}
              className="rounded border px-2 py-1 text-xs hover:bg-card">Mark unread</button>
            {members.length > 0 && (
              <div className="flex items-center gap-1">
                <select value={bulkAssignee} onChange={(e) => setBulkAssignee(e.target.value)}
                  className="rounded border bg-background px-1.5 py-1 text-xs">
                  <option value="">Assign to…</option>
                  <option value="__none">Unassign</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                {bulkAssignee && (
                  <button onClick={() => bulkAction('assign', { assigneeId: bulkAssignee === '__none' ? null : bulkAssignee })}
                    disabled={bulkBusy} className="rounded border px-2 py-1 text-xs hover:bg-card">Apply</button>
                )}
              </div>
            )}
            <div className="flex items-center gap-1">
              <input ref={tagInputRef} value={bulkTag} onChange={(e) => setBulkTag(e.target.value)}
                placeholder="Add tag…" className="w-20 rounded border bg-background px-1.5 py-1 text-xs" />
              {bulkTag && (
                <button onClick={() => bulkAction('tag', { tagName: bulkTag })} disabled={bulkBusy}
                  className="rounded border px-2 py-1 text-xs hover:bg-card">Tag</button>
              )}
            </div>
            <button onClick={() => setSelected(new Set())}
              className="ml-auto text-xs text-muted-foreground hover:text-foreground">✕ Clear</button>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="p-6 text-sm text-muted-foreground">Loading…</div>
            ) : rows.length === 0 ? (
              <div className="p-12 text-center text-sm text-muted-foreground">
                {filter === 'unread' ? "You're all caught up." : 'No conversations yet.'}
              </div>
            ) : (
              <ul>
                {/* Select-all row */}
                <li className="flex items-center gap-2 border-b bg-muted/30 px-4 py-1.5">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll}
                    className="h-3.5 w-3.5 rounded accent-primary" aria-label="Select all" />
                  <span className="text-[11px] text-muted-foreground">
                    {allSelected ? 'Deselect all' : `Select all ${rows.length} on this page`}
                  </span>
                </li>

                {rows.map((c) => {
                  const isColdInbound = c.firstMessageDirection === 'INBOUND';
                  const isChecked = selected.has(c.id);
                  return (
                    <li key={c.id} className={`border-b ${isChecked ? 'bg-primary/5' : ''}`}>
                      <div className="flex items-stretch">
                        {/* Checkbox column */}
                        <div className="flex shrink-0 items-center px-3" onClick={(e) => { e.preventDefault(); toggleRow(c.id); }}>
                          <input type="checkbox" checked={isChecked} onChange={() => toggleRow(c.id)}
                            className="h-3.5 w-3.5 rounded accent-primary" onClick={(e) => e.stopPropagation()} />
                        </div>
                        {/* Conversation link */}
                        <Link href={`/inbox/${c.id}`}
                          className={`block min-w-0 flex-1 py-3 pr-4 hover:bg-elevated/60 ${c.unread ? 'bg-primary/5' : ''}`}>
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                {c.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
                                <span className={`truncate text-sm ${c.unread ? 'font-semibold' : 'font-medium'}`}>
                                  {c.contact?.name || c.recipientEmail}
                                </span>
                                {c.assignee && (
                                  <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">{c.assignee.name}</span>
                                )}
                                {isColdInbound && (
                                  <span className="shrink-0 rounded border border-warning/40 bg-warning/10 px-1.5 text-[10px] text-warning">
                                    direct inbound
                                  </span>
                                )}
                              </div>
                              <div className="truncate text-sm">{c.subject}</div>
                              <div className="truncate text-xs text-muted-foreground">
                                {c.lastMessage?.direction === 'OUTBOUND' && <span className="mr-1">You:</span>}
                                {c.lastMessage?.classification && c.lastMessage.classification !== 'HUMAN_REPLY' && (
                                  <span className="mr-1 rounded bg-warning/15 px-1 text-[10px] text-warning">
                                    {c.lastMessage.classification.replace(/_/g, ' ').toLowerCase()}
                                  </span>
                                )}
                                {c.lastMessage?.snippet ?? ''}
                              </div>
                              {c.tags.length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {c.tags.map((t) => (
                                    <span key={t.name} className="rounded px-1.5 text-[10px]"
                                      style={{ background: t.color ? `${t.color}22` : undefined, color: t.color ?? undefined }}>
                                      {t.name}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                            <div className="shrink-0 text-right text-xs text-muted-foreground">
                              <div>{timeAgo(c.lastMessageAt)}</div>
                              <div className="mt-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px]">{c.status.replace(/_/g, ' ').toLowerCase()}</div>
                              <div className="mt-0.5 text-[10px]">{c.messageCount} msg{c.messageCount !== 1 ? 's' : ''}</div>
                            </div>
                          </div>
                        </Link>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t bg-card px-4 py-2 text-xs text-muted-foreground">
              <span>Page {page} of {totalPages}</span>
              <div className="flex gap-2">
                <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
                  className="rounded border px-3 py-1 hover:bg-elevated disabled:opacity-40">← Prev</button>
                <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}
                  className="rounded border px-3 py-1 hover:bg-elevated disabled:opacity-40">Next →</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
