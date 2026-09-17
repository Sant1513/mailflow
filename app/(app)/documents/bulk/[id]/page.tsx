'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';

type SigningStatus = 'DRAFT' | 'SENT' | 'VIEWED' | 'SIGNED' | 'EXPIRED' | 'VOIDED';

interface RequestRow {
  id: string;
  recipientName: string;
  recipientEmail: string;
  status: SigningStatus;
  sentAt: string | null;
  signedAt: string | null;
  token: string;
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
            {batch.requests.map((req, i) => (
              <tr
                key={req.id}
                className={`border-t border-border-subtle ${i % 2 === 1 ? 'bg-muted/30' : ''}`}
              >
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
                <td className="px-4 py-2">
                  {['SENT', 'VIEWED'].includes(req.status) && (
                    <button
                      onClick={() => resend(req.id)}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Resend
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
