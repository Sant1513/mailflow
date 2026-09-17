'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

interface Suppression {
  id: string;
  email: string;
  reason: string;
  source: string;
  detail: string | null;
  createdAt: string;
  addedBy: { name: string; email: string } | null;
  campaign: { id: string; name: string } | null;
}

const SOURCE_BADGE: Record<string, string> = {
  MANUAL: 'badge-neutral',
  BOUNCE: 'badge-danger',
  UNSUBSCRIBE: 'badge-warning',
  COMPLAINT: 'badge-orange',
};

const SOURCE_LABEL: Record<string, string> = {
  MANUAL: 'Manual',
  BOUNCE: 'Bounce',
  UNSUBSCRIBE: 'Unsubscribe',
  COMPLAINT: 'Complaint',
};

export default function SuppressionsPage() {
  const [rows, setRows] = useState<Suppression[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pageCount: 1 });
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  // Add form state
  const [showAdd, setShowAdd] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [addReason, setAddReason] = useState<'UNSUBSCRIBED' | 'BOUNCED' | 'COMPLAINT'>('UNSUBSCRIBED');
  const [addDetail, setAddDetail] = useState('');
  const [adding, setAdding] = useState(false);

  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(
      `/api/suppressions?q=${encodeURIComponent(q.trim())}&page=${page}`
    );
    if (!res.ok) {
      toast.error('Could not load suppression list');
      setLoading(false);
      return;
    }
    const json = await res.json();
    setRows(json.suppressions ?? []);
    setMeta({ total: json.total, page: json.page, pageCount: json.pageCount });
    setLoading(false);
  }, [q, page]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!addEmail.trim()) return;
    setAdding(true);
    const res = await fetch('/api/suppressions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: addEmail.trim(), reason: addReason, detail: addDetail.trim() || undefined }),
    });
    const json = await res.json().catch(() => ({}));
    setAdding(false);
    if (!res.ok) {
      toast.error(json.error ?? 'Could not add suppression');
      return;
    }
    toast.success(`${addEmail.trim()} added to suppression list`);
    setAddEmail('');
    setAddDetail('');
    setShowAdd(false);
    setPage(1);
    load();
  }

  async function handleDelete(row: Suppression) {
    if (!confirm(`Remove ${row.email} from suppression list?`)) return;
    setDeleting(row.id);
    const res = await fetch(`/api/suppressions?id=${row.id}`, { method: 'DELETE' });
    setDeleting(null);
    if (!res.ok) {
      toast.error('Could not remove suppression');
      return;
    }
    toast.success(`${row.email} removed`);
    load();
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Suppression List</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Emails here are skipped on every future send — bounce auto-suppressions are added automatically.
          </p>
        </div>
        <button className="btn-primary shrink-0" onClick={() => setShowAdd((v) => !v)}>
          + Add email
        </button>
      </div>

      {showAdd && (
        <form
          onSubmit={handleAdd}
          className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4"
        >
          <div className="flex-1 min-w-48">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Email address</label>
            <input
              type="email"
              required
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value)}
              placeholder="user@example.com"
              className="input w-full"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Reason</label>
            <select
              value={addReason}
              onChange={(e) => setAddReason(e.target.value as typeof addReason)}
              className="input"
            >
              <option value="UNSUBSCRIBED">Unsubscribed</option>
              <option value="BOUNCED">Bounced</option>
              <option value="COMPLAINT">Complaint</option>
            </select>
          </div>
          <div className="flex-1 min-w-48">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Detail (optional)</label>
            <input
              type="text"
              value={addDetail}
              onChange={(e) => setAddDetail(e.target.value)}
              placeholder="e.g. requested via support ticket"
              className="input w-full"
            />
          </div>
          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={adding}>
              {adding ? 'Adding…' : 'Add'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setShowAdd(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="mb-4 flex items-center gap-3">
        <input
          type="search"
          placeholder="Search by email…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          className="input max-w-xs"
        />
        <span className="text-sm text-muted-foreground">
          {loading ? 'Loading…' : `${meta.total.toLocaleString()} suppressed address${meta.total !== 1 ? 'es' : ''}`}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="border-b bg-elevated text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Email</th>
              <th className="px-4 py-2 text-left font-medium">Source</th>
              <th className="px-4 py-2 text-left font-medium">Reason / Detail</th>
              <th className="px-4 py-2 text-left font-medium">Added by</th>
              <th className="px-4 py-2 text-left font-medium">Campaign</th>
              <th className="px-4 py-2 text-left font-medium">Date</th>
              <th className="px-4 py-2 text-left font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {q ? 'No matches.' : 'No suppressed addresses yet.'}
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-elevated/40">
                <td className="px-4 py-2 font-mono text-xs">{row.email}</td>
                <td className="px-4 py-2">
                  <span className={`badge ${SOURCE_BADGE[row.source] ?? 'badge-neutral'}`}>
                    {SOURCE_LABEL[row.source] ?? row.source}
                  </span>
                </td>
                <td className="px-4 py-2 max-w-xs">
                  <div className="text-xs text-muted-foreground">{row.reason}</div>
                  {row.detail && (
                    <div className="mt-0.5 truncate text-xs text-faint" title={row.detail}>
                      {row.detail}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  {row.source === 'BOUNCE' && !row.addedBy
                    ? <span className="italic">System (bounce)</span>
                    : row.addedBy
                    ? <span title={row.addedBy.email}>{row.addedBy.name}</span>
                    : <span className="text-faint">—</span>}
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  {row.campaign ? (
                    <a href={`/campaigns/${row.campaign.id}`} className="underline hover:text-foreground">
                      {row.campaign.name}
                    </a>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                  {new Date(row.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-2">
                  <button
                    onClick={() => handleDelete(row)}
                    disabled={deleting === row.id}
                    className="text-xs text-danger hover:underline disabled:opacity-50"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {meta.pageCount > 1 && (
        <div className="mt-4 flex items-center gap-3">
          <button
            className="btn-secondary"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            ← Previous
          </button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {meta.pageCount}
          </span>
          <button
            className="btn-secondary"
            disabled={page >= meta.pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
