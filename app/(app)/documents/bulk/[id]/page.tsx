'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { EditSigningRequestModal } from '@/components/documents/EditSigningRequestModal';

type SigningStatus = 'DRAFT' | 'SENT' | 'VIEWED' | 'SIGNED' | 'EXPIRED' | 'VOIDED';

interface RequestRow {
  id: string;
  recipientName: string;
  recipientEmail: string;
  fieldValues?: Record<string, string>;
  status: SigningStatus;
  sentAt: string | null;
  signedAt: string | null;
  token: string;
  groupId: string | null;
  signerOrder: number;
  signerRole: string | null;
}

interface GroupRow {
  id: string;
  signingOrder: string;
  totalSigners: number;
  signedCount: number;
  status: string;
}

interface BatchDetail {
  id: string;
  title: string;
  totalCount: number;
  sentCount: number;
  signedCount: number;
  createdAt: string;
  template: { title: string } | null;
  requests: RequestRow[];
  groups: GroupRow[];
}

interface Summary {
  total: number;
  sent: number;
  signed: number;
  pending: number;
}

const STATUS_BADGE: Record<SigningStatus, string> = {
  SIGNED: 'badge-success',
  SENT: 'badge-info',
  VIEWED: 'badge-warning',
  EXPIRED: 'badge',
  VOIDED: 'badge-destructive',
  DRAFT: 'badge',
};

export default function BulkSendDetailPage() {
  const params = useParams<{ id: string }>();
  const batchId = params.id;

  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/signing-batches/${batchId}`);
    setLoading(false);
    if (!res.ok) return;
    const json = (await res.json()) as { batch: BatchDetail; summary: Summary };
    setBatch(json.batch);
    setSummary(json.summary);
  }, [batchId]);

  useEffect(() => {
    load();
  }, [load]);

  async function voidBatch() {
    if (!batch) return;
    const res = await fetch(`/api/signing-batches/${batchId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'void' }),
    });
    if (!res.ok) {
      toast.error('Could not void batch');
      return;
    }
    toast.success('All pending requests voided');
    load();
  }

  async function resend(requestId: string) {
    const res = await fetch(`/api/e-sign/${requestId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resend' }),
    });
    if (!res.ok) {
      toast.error('Could not resend');
      return;
    }
    toast.success('Resent successfully');
    load();
  }

  const fmt = (d: string | null) =>
    d
      ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
      : '—';

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  if (!batch) {
    return (
      <div className="p-6">
        <Link href="/documents/bulk" className="text-sm text-muted-foreground hover:text-foreground">
          ← Bulk Sending
        </Link>
        <p className="mt-4 text-sm text-muted-foreground">Batch not found.</p>
      </div>
    );
  }

  const hasGroups = (batch.groups ?? []).length > 0;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <Link href="/documents/bulk" className="text-sm text-muted-foreground hover:text-foreground">
          ← Bulk Sending
        </Link>
        <div className="mt-3 flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{batch.title}</h1>
            <p className="text-sm text-muted-foreground">
              {batch.template ? `Template: ${batch.template.title}` : 'No template'} &middot; Created{' '}
              {new Date(batch.createdAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}
            </p>
          </div>
          {batch.requests.some((r) => ['SENT', 'VIEWED', 'DRAFT'].includes(r.status)) && (
            <button
              onClick={voidBatch}
              className="text-sm text-destructive border border-destructive/30 rounded px-3 py-1.5 hover:bg-destructive/10"
            >
              Void All Pending
            </button>
          )}
        </div>
      </div>

      {/* Summary tiles */}
      {summary && (
        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {(
            [
              { label: 'Total', value: summary.total },
              { label: 'Sent', value: summary.sent },
              { label: 'Signed', value: summary.signed },
              { label: 'Pending', value: summary.pending },
            ] as { label: string; value: number }[]
          ).map(({ label, value }) => (
            <div key={label} className="rounded-lg border bg-card p-4 text-center">
              <div className="text-3xl font-bold">{value}</div>
              <div className="mt-1 text-xs text-muted-foreground uppercase tracking-wide">
                {label}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Requests table */}
      <div className="overflow-x-auto overflow-hidden rounded-lg border bg-card">
        <table className="w-full min-w-[700px] text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-2">Recipient</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2 whitespace-nowrap">Sent</th>
              <th className="px-4 py-2 whitespace-nowrap">Signed</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {hasGroups ? (
              // Group requests by their SigningGroup (one row per CSV row)
              batch.groups.map((group) => {
                const groupRequests = batch.requests.filter((r) => r.groupId === group.id);
                return (
                  <React.Fragment key={group.id}>
                    <tr className="bg-muted/50 border-t border-border">
                      <td colSpan={5} className="px-4 py-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium">
                            Row — {groupRequests.map((r) => r.recipientName).join(', ')}
                          </span>
                          <span className={`badge text-[10px] ${group.status === 'COMPLETED' ? 'badge-success' : group.status === 'IN_PROGRESS' ? 'badge-warning' : 'badge'}`}>
                            {group.status}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {group.signedCount}/{group.totalSigners} signed · {group.signingOrder.toLowerCase()}
                          </span>
                          {group.status === 'COMPLETED' && (
                            <a
                              href={`/api/signing-groups/${group.id}/download`}
                              className="ml-auto text-[10px] text-primary hover:underline"
                              target="_blank"
                              rel="noreferrer"
                            >
                              Download PDF
                            </a>
                          )}
                        </div>
                      </td>
                    </tr>
                    {groupRequests.map((req, j) => (
                      <tr
                        key={req.id}
                        className={`border-t border-border-subtle ${j % 2 === 1 ? 'bg-muted/20' : ''}`}
                      >
                        <td className="px-4 py-2 pl-8">
                          <div className="flex items-center gap-2">
                            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
                              {req.signerOrder + 1}
                            </span>
                            <div>
                              <div className="text-xs font-medium">{req.recipientName}</div>
                              <div className="text-xs text-muted-foreground">{req.recipientEmail}</div>
                            </div>
                          </div>
                          {req.signerRole && (
                            <div className="mt-0.5 pl-6 text-[11px] text-muted-foreground">{req.signerRole}</div>
                          )}
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
                        <td className="px-4 py-2">
                          <div className="flex gap-3">
                            <button
                              onClick={() => setEditingId(req.id)}
                              className="text-xs text-primary hover:underline"
                            >
                              {['DRAFT', 'SENT', 'VIEWED'].includes(req.status) ? 'Preview / Edit' : 'Preview'}
                            </button>
                            {['SENT', 'VIEWED'].includes(req.status) && (
                              <button
                                onClick={() => resend(req.id)}
                                className="text-xs text-muted-foreground hover:text-foreground"
                              >
                                Resend
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })
            ) : (
              batch.requests.map((req, i) => (
                <tr
                  key={req.id}
                  className={`border-t border-border-subtle ${i % 2 === 1 ? 'bg-muted/30' : ''}`}
                >
                  <td className="px-4 py-2">
                    <div className="text-xs font-medium">{req.recipientName}</div>
                    <div className="text-xs text-muted-foreground">{req.recipientEmail}</div>
                    {req.signerRole && (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">Role: {req.signerRole}</div>
                    )}
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
                  <td className="px-4 py-2">
                    <div className="flex gap-3">
                      <button
                        onClick={() => setEditingId(req.id)}
                        className="text-xs text-primary hover:underline"
                      >
                        {['DRAFT', 'SENT', 'VIEWED'].includes(req.status) ? 'Preview / Edit' : 'Preview'}
                      </button>
                      {['SENT', 'VIEWED'].includes(req.status) && (
                        <button
                          onClick={() => resend(req.id)}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          Resend
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editingId && (
        <EditSigningRequestModal requestId={editingId} onClose={() => setEditingId(null)} onSaved={load} />
      )}
    </div>
  );
}
