'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { EditSigningRequestModal } from '@/components/documents/EditSigningRequestModal';

const PAGE_SIZE = 20;

type SigningStatus = 'DRAFT' | 'SENT' | 'VIEWED' | 'SIGNED' | 'EXPIRED' | 'VOIDED';

interface SigningRequest {
  id: string;
  title: string;
  recipientName: string;
  recipientEmail: string;
  status: SigningStatus;
  sentAt: string | null;
  signedAt: string | null;
  createdAt: string;
  sentBy: { name: string; email: string } | null;
}

interface ESignDetail {
  id: string;
  title: string;
  token: string;
  signedPdfData: string | null;
}

const STATUS_BADGE: Record<SigningStatus, string> = {
  SIGNED: 'badge-success',
  SENT: 'badge-info',
  VIEWED: 'badge-warning',
  EXPIRED: 'badge',
  VOIDED: 'badge-destructive',
  DRAFT: 'badge',
};

export default function ESignDocumentsPage() {
  const [requests, setRequests] = useState<SigningRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  // Filters
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(
    async (pg: number) => {
      setLoading(true);
      const p = new URLSearchParams({ page: String(pg) });
      if (search) p.set('search', search);
      if (status) p.set('status', status);
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      const res = await fetch(`/api/e-sign?${p}`);
      setLoading(false);
      if (!res.ok) return;
      const json = (await res.json()) as { requests: SigningRequest[]; total: number; page: number };
      setRequests(json.requests ?? []);
      setTotal(json.total ?? 0);
    },
    [search, status, from, to],
  );

  useEffect(() => {
    load(page);
  }, [load, page]);

  function reset() {
    setSearch('');
    setStatus('');
    setFrom('');
    setTo('');
    setPage(1);
    setSelectedIds([]);
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => (prev.length === requests.length ? [] : requests.map((r) => r.id)));
  }

  async function bulkVoid() {
    if (!confirm(`Void ${selectedIds.length} selected request${selectedIds.length > 1 ? 's' : ''}?`)) return;
    await Promise.allSettled(
      selectedIds.map((id) =>
        fetch(`/api/e-sign/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'void' }),
        })
      )
    );
    toast.success(`Voided ${selectedIds.length} request${selectedIds.length > 1 ? 's' : ''}`);
    setSelectedIds([]);
    load(page);
  }

  async function bulkResend() {
    if (!confirm(`Resend ${selectedIds.length} selected request${selectedIds.length > 1 ? 's' : ''}?`)) return;
    await Promise.allSettled(
      selectedIds.map((id) =>
        fetch(`/api/e-sign/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'resend' }),
        })
      )
    );
    toast.success(`Resent ${selectedIds.length} request${selectedIds.length > 1 ? 's' : ''}`);
    setSelectedIds([]);
  }

  async function viewPdf(id: string, format: 'html' | 'pdf' = 'html') {
    // Open synchronously so pop-up blockers allow the tab, then point it at the document.
    const win = window.open('', '_blank');
    const res = await fetch(`/api/e-sign/${id}`);
    if (!res.ok) {
      win?.close();
      toast.error('Could not fetch document');
      return;
    }
    const json = (await res.json()) as { request: ESignDetail };
    const token = json.request?.token;
    if (!token) {
      win?.close();
      toast.error('Document not available');
      return;
    }
    const url = `/api/sign/${token}/download${format === 'pdf' ? '?format=pdf' : ''}`;
    if (win) win.location.href = url;
    else window.open(url, '_blank');
  }

  async function voidRequest(id: string) {
    if (!confirm('Void this signing request?')) return;
    const res = await fetch(`/api/e-sign/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'void' }),
    });
    if (!res.ok) {
      toast.error('Could not void request');
      return;
    }
    toast.success('Request voided');
    load(page);
  }

  async function restartRequest(id: string) {
    if (!confirm('Create a fresh signing request for the same document and recipient?')) return;
    const res = await fetch(`/api/e-sign/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'restart' }),
    });
    if (!res.ok) {
      toast.error('Could not restart request');
      return;
    }
    toast.success('New signing request sent');
    load(page);
  }

  async function resendRequest(id: string) {
    const res = await fetch(`/api/e-sign/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resend' }),
    });
    if (!res.ok) {
      toast.error('Could not resend request');
      return;
    }
    toast.success('Request resent successfully');
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const fmt = (d: string | null) =>
    d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

  return (
    <div className="p-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Documents</h1>
          <p className="text-sm text-muted-foreground">E-signature requests sent to recipients.</p>
        </div>
        <div className="flex items-center gap-2">
          {loading && <span className="text-xs text-muted-foreground">Loading…</span>}
          <Link href="/documents/templates" className="btn-secondary">
            Templates
          </Link>
          <Link href="/documents/bulk/new" className="btn-secondary">
            Bulk Send
          </Link>
          <Link href="/documents/new" className="btn-primary">
            New Request
          </Link>
        </div>
      </div>

      {/* Filter bar */}
      <div className="mb-5 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Search</label>
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Title or recipient…"
              className="!py-1 text-sm w-48"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Status</label>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              className="!py-1 text-sm min-w-[140px]"
            >
              <option value="">All</option>
              <option value="SENT">Sent</option>
              <option value="VIEWED">Viewed</option>
              <option value="SIGNED">Signed</option>
              <option value="EXPIRED">Expired</option>
              <option value="VOIDED">Voided</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">From</label>
            <input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
              className="!py-1 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">To</label>
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
              className="!py-1 text-sm"
            />
          </div>
          <button onClick={reset} className="btn-secondary !px-3 !py-1 text-xs">
            Reset
          </button>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          {total.toLocaleString()} request{total !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Bulk action toolbar */}
      {selectedIds.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-blue-100 bg-blue-50 px-4 py-2">
          <span className="text-sm font-medium text-blue-900">
            {selectedIds.length} selected
          </span>
          <button onClick={bulkVoid} className="btn-secondary !px-3 !py-1 text-xs">
            Void Selected
          </button>
          <button onClick={bulkResend} className="btn-secondary !px-3 !py-1 text-xs">
            Resend Selected
          </button>
          <button
            onClick={() => setSelectedIds([])}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Table */}
      {requests.length === 0 && !loading ? (
        <div className="mt-16 text-center text-sm text-muted-foreground">
          No documents yet. Send your first signing request.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto overflow-hidden rounded-lg border bg-card">
            <table className="w-full min-w-[800px] text-sm">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="w-8 px-4 py-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.length === requests.length && requests.length > 0}
                      onChange={toggleSelectAll}
                      className="h-4 w-4 accent-gray-900"
                      aria-label="Select all"
                    />
                  </th>
                  <th className="px-4 py-2">Title</th>
                  <th className="px-4 py-2">Recipient</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2 whitespace-nowrap">Sent</th>
                  <th className="px-4 py-2 whitespace-nowrap">Signed</th>
                  <th className="px-4 py-2 whitespace-nowrap">Sent by</th>
                  <th className="px-4 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((req, i) => (
                  <tr key={req.id} className={`border-t border-border-subtle ${i % 2 === 1 ? 'bg-muted/30' : ''}`}>
                    <td className="w-8 px-4 py-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(req.id)}
                        onChange={() => toggleSelect(req.id)}
                        className="h-4 w-4 accent-gray-900"
                        aria-label="Select row"
                      />
                    </td>
                    <td className="px-4 py-2 font-medium">{req.title}</td>
                    <td className="px-4 py-2">
                      <div className="text-xs font-medium">{req.recipientName}</div>
                      <div className="text-xs text-muted-foreground">{req.recipientEmail}</div>
                    </td>
                    <td className="px-4 py-2">
                      <span className={`badge ${STATUS_BADGE[req.status]}`}>{req.status}</span>
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {fmt(req.sentAt)}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {fmt(req.signedAt)}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {req.sentBy ? (
                        <>
                          <div>{req.sentBy.name}</div>
                          <div className="text-faint">{req.sentBy.email.split('@')[0]}</div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-2 text-xs">
                        {req.status === 'SIGNED' && (
                          <>
                            <button onClick={() => viewPdf(req.id)} className="text-primary hover:underline">
                              View Document
                            </button>
                            <button onClick={() => viewPdf(req.id, 'pdf')} className="text-primary hover:underline">
                              PDF
                            </button>
                          </>
                        )}
                        {['DRAFT', 'SENT', 'VIEWED'].includes(req.status) && (
                          <button onClick={() => setEditingId(req.id)} className="text-primary hover:underline">
                            Preview / Edit
                          </button>
                        )}
                        {['VOIDED', 'EXPIRED'].includes(req.status) && (
                          <button onClick={() => setEditingId(req.id)} className="text-muted-foreground hover:text-foreground">
                            Preview
                          </button>
                        )}
                        {['SIGNED', 'VOIDED', 'EXPIRED'].includes(req.status) && (
                          <button
                            onClick={() => restartRequest(req.id)}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            Re-request
                          </button>
                        )}
                        {!['SIGNED', 'VOIDED', 'EXPIRED'].includes(req.status) && (
                          <button
                            onClick={() => voidRequest(req.id)}
                            className="text-muted-foreground hover:text-primary"
                          >
                            Void
                          </button>
                        )}
                        {['SENT', 'VIEWED'].includes(req.status) && (
                          <button
                            onClick={() => resendRequest(req.id)}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            Resend
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between text-sm">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="btn-secondary !px-3 !py-1 text-xs disabled:opacity-40"
              >
                ← Prev
              </button>
              <span className="text-muted-foreground">
                Page {page} of {totalPages} · {total.toLocaleString()} total
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="btn-secondary !px-3 !py-1 text-xs disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}

      {editingId && (
        <EditSigningRequestModal
          requestId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => load(page)}
        />
      )}
    </div>
  );
}
