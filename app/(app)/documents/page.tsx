'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { EditSigningRequestModal } from '@/components/documents/EditSigningRequestModal';

const PAGE_SIZE = 20;

type SigningStatus = 'DRAFT' | 'SENT' | 'VIEWED' | 'SIGNED' | 'EXPIRED' | 'VOIDED';
type DocumentStatus = SigningStatus | 'IN_PROGRESS';

interface DocumentSigner {
  id: string;
  recipientName: string;
  recipientEmail: string;
  signerRole: string | null;
  signerOrder: number;
  status: SigningStatus;
  signedAt: string | null;
}

/** One document: a single request, or a multi-signer group led by its first signer. */
interface SigningRequest {
  id: string;
  title: string;
  recipientName: string;
  recipientEmail: string;
  status: SigningStatus;
  documentStatus: DocumentStatus;
  sentAt: string | null;
  signedAt: string | null;
  createdAt: string;
  sentBy: { name: string; email: string } | null;
  signers: DocumentSigner[] | null;
  totalSigners?: number;
  signedCount?: number;
}

const SIGNER_STATUS_LABEL: Record<SigningStatus, string> = {
  DRAFT: 'Waiting for turn',
  SENT: 'Sent',
  VIEWED: 'Viewed',
  SIGNED: 'Signed',
  EXPIRED: 'Expired',
  VOIDED: 'Voided',
};

interface ESignDetail {
  id: string;
  title: string;
  token: string;
  signedPdfData: string | null;
}

const STATUS_BADGE: Record<DocumentStatus, string> = {
  SIGNED: 'badge-success',
  SENT: 'badge-info',
  VIEWED: 'badge-warning',
  EXPIRED: 'badge',
  VOIDED: 'badge-destructive',
  DRAFT: 'badge',
  IN_PROGRESS: 'badge-warning',
};

const SIGNER_DOT: Record<SigningStatus, string> = {
  SIGNED: 'bg-emerald-500',
  VIEWED: 'bg-amber-400',
  SENT: 'bg-blue-500',
  DRAFT: 'bg-gray-300',
  EXPIRED: 'bg-gray-400',
  VOIDED: 'bg-red-400',
};

function DocumentActions({
  doc,
  onView,
  onEdit,
  onRestart,
  onVoid,
  onResend,
}: {
  doc: SigningRequest;
  onView: (format: 'html' | 'pdf') => void;
  onEdit: () => void;
  onRestart: () => void;
  onVoid: () => void;
  onResend: () => void;
}) {
  const status = doc.documentStatus;
  const multi = !!doc.signers;
  const open = status === 'IN_PROGRESS' || status === 'DRAFT' || status === 'SENT' || status === 'VIEWED';
  const someoneWaiting = multi
    ? doc.signers!.some((s) => s.status === 'SENT' || s.status === 'VIEWED')
    : status === 'SENT' || status === 'VIEWED';
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {status === 'SIGNED' && (
        <>
          {/* A finished multi-signer document is the combined PDF with every signature. */}
          {!multi && (
            <button onClick={() => onView('html')} className="text-primary hover:underline">
              View Document
            </button>
          )}
          <button onClick={() => onView('pdf')} className="text-primary hover:underline">
            {multi ? 'View PDF' : 'PDF'}
          </button>
        </>
      )}
      {open ? (
        <button onClick={onEdit} className="text-primary hover:underline">
          Preview / Edit
        </button>
      ) : (
        status !== 'SIGNED' && (
          <button onClick={onEdit} className="text-muted-foreground hover:text-foreground">
            Preview
          </button>
        )
      )}
      {!multi && (status === 'SIGNED' || status === 'VOIDED' || status === 'EXPIRED') && (
        <button onClick={onRestart} className="text-muted-foreground hover:text-foreground">
          Re-request
        </button>
      )}
      {open && (
        <button onClick={onVoid} className="text-muted-foreground hover:text-primary">
          Void
        </button>
      )}
      {open && someoneWaiting && (
        <button onClick={onResend} className="text-muted-foreground hover:text-foreground" title="Remind whoever needs to sign next">
          Resend
        </button>
      )}
    </div>
  );
}

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

  async function voidRequest(doc: SigningRequest) {
    const message = doc.signers
      ? `Void "${doc.title}" for all ${doc.signers.length} signers? Anyone who hasn't signed will no longer be able to.`
      : 'Void this signing request?';
    if (!confirm(message)) return;
    const res = await fetch(`/api/e-sign/${doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'void' }),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(json.error ?? 'Could not void the document');
      return;
    }
    toast.success('Document voided');
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
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(json.error ?? 'Could not restart request');
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
    const json = (await res.json().catch(() => ({}))) as { error?: string; recipients?: string[] };
    if (!res.ok) {
      toast.error(json.error ?? 'Could not resend request');
      return;
    }
    toast.success(json.recipients?.length ? `Reminder sent to ${json.recipients.join(', ')}` : 'Reminder sent');
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const fmt = (d: string | null) =>
    d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Documents</h1>
          <p className="text-sm text-muted-foreground">E-signature requests sent to recipients.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
              <option value="IN_PROGRESS">In progress (multi-signer)</option>
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
          {total.toLocaleString()} document{total !== 1 ? 's' : ''}
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
                    <td className="px-4 py-2 font-medium align-top">
                      {req.title}
                      {req.signers && (
                        <div className="mt-0.5 text-[11px] font-normal text-muted-foreground">
                          {req.signers.length} signers
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 align-top">
                      {req.signers ? (
                        <ol className="space-y-1">
                          {req.signers.map((s) => (
                            <li key={s.id} className="flex items-start gap-1.5">
                              <span
                                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SIGNER_DOT[s.status]}`}
                                title={SIGNER_STATUS_LABEL[s.status]}
                              />
                              <div className="min-w-0">
                                <div className="text-xs font-medium">
                                  {s.signerOrder + 1}. {s.recipientName}
                                  <span className="font-normal text-muted-foreground">
                                    {' '}· {s.signerRole ?? `Signer ${s.signerOrder + 1}`} · {SIGNER_STATUS_LABEL[s.status]}
                                  </span>
                                </div>
                                <div className="truncate text-[11px] text-muted-foreground">{s.recipientEmail}</div>
                              </div>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <>
                          <div className="text-xs font-medium">{req.recipientName}</div>
                          <div className="text-xs text-muted-foreground">{req.recipientEmail}</div>
                        </>
                      )}
                    </td>
                    <td className="px-4 py-2 align-top">
                      <span className={`badge ${STATUS_BADGE[req.documentStatus]}`}>
                        {req.documentStatus === 'IN_PROGRESS'
                          ? `IN PROGRESS ${req.signedCount ?? 0}/${req.totalSigners ?? req.signers?.length ?? 0}`
                          : req.documentStatus}
                      </span>
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
                    <td className="px-4 py-2 align-top">
                      <DocumentActions
                        doc={req}
                        onView={(format) => viewPdf(req.id, format)}
                        onEdit={() => setEditingId(req.id)}
                        onRestart={() => restartRequest(req.id)}
                        onVoid={() => voidRequest(req)}
                        onResend={() => resendRequest(req.id)}
                      />
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
