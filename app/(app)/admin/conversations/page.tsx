'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';

interface Row {
  id: string;
  subject: string;
  status: string;
  unread: boolean;
  recipientEmail: string;
  messageCount: number;
  lastMessageAt: string | null;
  workspace: { id: string; name: string; owner: { name: string } };
  contact: { id: string; name: string | null };
  account: { emailAddress: string };
  assignee: { name: string } | null;
  last: { snippet: string | null; direction: string; classification: string } | null;
}

const STATUS_BADGE: Record<string, string> = {
  OPEN: 'badge-info',
  IN_PROGRESS: 'badge-info',
  WAITING_FOR_STUDENT: 'badge-warning',
  RESOLVED: 'badge-success',
  CLOSED: 'badge-neutral',
};

/** §9 All Conversations — organisation-wide, SUPER_ADMIN only, every read audited. */
export default function AdminConversationsPage() {
  const [q, setQ] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Row[]>([]);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pageCount: 1 });
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(page) });
    if (q.trim()) qs.set('q', q.trim());
    if (workspaceId) qs.set('workspaceId', workspaceId);
    if (status) qs.set('status', status);
    const res = await fetch(`/api/admin/conversations?${qs}`);
    if (res.status === 403) {
      setForbidden(true);
      setLoading(false);
      return;
    }
    if (!res.ok) {
      toast.error('Could not load conversations');
      setLoading(false);
      return;
    }
    const json = await res.json();
    setRows(json.conversations ?? []);
    setWorkspaces(json.workspaces ?? []);
    setMeta({ total: json.total, page: json.page, pageCount: json.pageCount });
    setLoading(false);
  }, [q, workspaceId, status, page]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  if (forbidden) {
    return (
      <div className="p-6">
        <h1 className="font-heading text-2xl font-bold tracking-tight">All Conversations</h1>
        <p className="mt-2 text-sm text-muted-foreground">Super admin only.</p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <div className="eyebrow mb-2">Super Admin · audited</div>
        <h1 className="font-heading text-2xl font-bold tracking-tight">All Conversations</h1>
        <p className="mt-1 text-sm text-muted-foreground">Every conversation across every workspace and mailbox. Opening one is a cross-workspace view (§9) and is logged.</p>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search subject, student, mailbox…" className="w-full !py-1.5 text-sm sm:w-72" />
        <select value={workspaceId} onChange={(e) => { setWorkspaceId(e.target.value); setPage(1); }} className="!w-auto !py-1.5 text-xs">
          <option value="">All workspaces</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
        <div className="flex rounded-full border border-border bg-card p-1">
          {([['', 'all'], ['unread', 'unread'], ['open', 'open'], ['resolved', 'resolved']] as const).map(([v, label]) => (
            <button key={v} onClick={() => { setStatus(v); setPage(1); }} className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${status === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              {label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-faint">{meta.total} conversation{meta.total === 1 ? '' : 's'}</span>
      </div>

      <div className="panel overflow-hidden">
        {loading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">No conversations match.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Conversation</th>
                  <th className="px-4 py-2">Student</th>
                  <th className="hidden px-4 py-2 md:table-cell">Workspace · mailbox</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="hidden px-4 py-2 lg:table-cell">Last message</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-t border-border-subtle align-top">
                    <td className="max-w-[360px] px-4 py-3">
                      <Link href={`/inbox/${c.id}`} className={`flex items-center gap-2 hover:text-primary ${c.unread ? 'font-semibold' : ''}`}>
                        {c.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="unread" />}
                        <span className="truncate">{c.subject || '(no subject)'}</span>
                      </Link>
                      <div className="truncate text-xs text-faint" title={c.last?.snippet ?? ''}>
                        {c.last ? `${c.last.direction === 'INBOUND' ? '←' : '→'} ${c.last.snippet ?? ''}` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/contacts/${c.contact.id}`} className="hover:text-primary">{c.contact.name || c.recipientEmail}</Link>
                      <div className="text-xs text-faint">{c.recipientEmail}</div>
                    </td>
                    <td className="hidden px-4 py-3 text-xs md:table-cell">
                      <div>{c.workspace.name}</div>
                      <div className="text-faint">{c.account.emailAddress}</div>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className={`badge ${STATUS_BADGE[c.status] ?? 'badge-neutral'}`}>{c.status.replace(/_/g, ' ').toLowerCase()}</span>
                      {c.assignee && <div className="mt-1 text-faint">→ {c.assignee.name}</div>}
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-muted-foreground lg:table-cell">
                      {c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}
                      <div className="text-faint">{c.messageCount} message{c.messageCount === 1 ? '' : 's'}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {meta.pageCount > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="btn-secondary !py-1 text-[11px]">‹ Prev</button>
          <span>Page {meta.page} of {meta.pageCount}</span>
          <button onClick={() => setPage((p) => Math.min(meta.pageCount, p + 1))} disabled={page >= meta.pageCount} className="btn-secondary !py-1 text-[11px]">Next ›</button>
        </div>
      )}
    </div>
  );
}
