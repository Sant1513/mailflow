'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';

interface BatchRow {
  id: string;
  label: string;
  status: string;
  total: number;
  validCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  pendingCount: number;
  createdAt: string;
  updatedAt: string;
  campaign: { id: string; name: string; status: string; createdBy: { name: string } };
  _count: { jobs: number };
}

const BADGE: Record<string, string> = {
  PREPARING: 'badge-neutral',
  QUEUED: 'badge-info',
  RUNNING: 'badge-info',
  PAUSED: 'badge-warning',
  COMPLETED: 'badge-success',
  PARTIALLY_FAILED: 'badge-warning',
  FAILED: 'badge-danger',
  CANCELLED: 'badge-neutral',
};

/** §40 batch monitor: every send batch in the workspace with live progress and queue controls. */
export default function BatchesPage() {
  const [tab, setTab] = useState<'active' | 'done' | 'all'>('all');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [meta, setMeta] = useState({ total: 0, activeCount: 0, page: 1, pageCount: 1 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/batches?status=${tab}&q=${encodeURIComponent(q.trim())}&page=${page}`);
    if (!res.ok) {
      toast.error('Could not load batches');
      setLoading(false);
      return;
    }
    const json = await res.json();
    setRows(json.batches ?? []);
    setMeta({ total: json.total, activeCount: json.activeCount, page: json.page, pageCount: json.pageCount });
    setLoading(false);
  }, [tab, q, page]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  // Live refresh while anything is in flight.
  useEffect(() => {
    if (meta.activeCount === 0) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [meta.activeCount, load]);

  async function control(batch: BatchRow, action: 'PAUSE' | 'RESUME' | 'CANCEL' | 'RETRY_FAILED' | 'DRAIN') {
    if (action === 'CANCEL' && !confirm(`Cancel ${batch.label}? Queued emails will not be sent.`)) return;
    setBusy(`${batch.id}:${action}`);
    const res =
      action === 'DRAIN'
        ? await fetch(`/api/batches/${batch.id}/drain`, { method: 'POST' })
        : await fetch(`/api/batches/${batch.id}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      toast.error(json.error ?? 'Action failed');
      return;
    }
    toast.success(action === 'DRAIN' ? `Processed ${json.processed ?? json.sent ?? ''} queued email(s)`.replace('  ', ' ') : `${batch.label}: ${action.toLowerCase().replace('_', ' ')}`);
    load();
  }

  const isActive = (s: string) => ['PREPARING', 'QUEUED', 'RUNNING', 'PAUSED'].includes(s);

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow mb-2">Sending</div>
          <h1 className="font-heading text-2xl font-bold tracking-tight">Batches</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Queue progress for every send. {meta.activeCount > 0 ? `${meta.activeCount} in flight — refreshing every 5s.` : 'Nothing is in flight.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-full border border-border bg-card p-1">
            {(['all', 'active', 'done'] as const).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setTab(t);
                  setPage(1);
                }}
                className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="Search batch or campaign…"
            className="w-full !py-1.5 text-sm sm:w-64"
          />
        </div>
      </div>

      <div className="panel overflow-hidden">
        {loading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No batches yet. Sending a campaign creates one — see <Link href="/campaigns" className="text-primary hover:underline">Campaigns</Link>.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Batch</th>
                  <th className="px-4 py-2">Progress</th>
                  <th className="hidden px-4 py-2 md:table-cell">Sent / Failed / Skipped</th>
                  <th className="hidden px-4 py-2 lg:table-cell">Started</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => {
                  const done = b.sentCount + b.failedCount + b.skippedCount;
                  const pct = b.total ? Math.round((done / b.total) * 100) : 0;
                  return (
                    <tr key={b.id} className="border-t border-border-subtle align-top">
                      <td className="px-4 py-3">
                        <Link href={`/campaigns/${b.campaign.id}`} className="font-medium hover:text-primary">{b.campaign.name}</Link>
                        <div className="text-xs text-faint">
                          <span className={`badge ${BADGE[b.status] ?? 'badge-neutral'} mr-2`}>{b.status.replace(/_/g, ' ').toLowerCase()}</span>
                          {b.label} · by {b.campaign.createdBy.name}
                        </div>
                      </td>
                      <td className="min-w-[160px] px-4 py-3">
                        <div className="mb-1 flex justify-between text-xs tabular-nums">
                          <span>{done} / {b.total}</span>
                          <span className="text-faint">{pct}%{b.pendingCount ? ` · ${b.pendingCount} queued` : ''}</span>
                        </div>
                        <div className="h-2 overflow-hidden rounded bg-muted">
                          <div className="flex h-full">
                            <div className="h-full bg-success transition-all" style={{ width: `${b.total ? (b.sentCount / b.total) * 100 : 0}%` }} />
                            <div className="h-full bg-primary transition-all" style={{ width: `${b.total ? (b.failedCount / b.total) * 100 : 0}%` }} />
                            <div className="h-full bg-faint/60 transition-all" style={{ width: `${b.total ? (b.skippedCount / b.total) * 100 : 0}%` }} />
                          </div>
                        </div>
                      </td>
                      <td className="hidden px-4 py-3 text-xs tabular-nums md:table-cell">
                        <span className="text-success">{b.sentCount}</span> / <span className={b.failedCount ? 'text-primary' : ''}>{b.failedCount}</span> / <span className="text-muted-foreground">{b.skippedCount}</span>
                      </td>
                      <td className="hidden px-4 py-3 text-xs text-muted-foreground lg:table-cell">
                        {new Date(b.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-1">
                          {isActive(b.status) && b.status !== 'PAUSED' && (
                            <button onClick={() => control(b, 'PAUSE')} disabled={!!busy} className="btn-secondary !py-1 text-[11px]">Pause</button>
                          )}
                          {b.status === 'PAUSED' && (
                            <button onClick={() => control(b, 'RESUME')} disabled={!!busy} className="btn-primary !py-1 text-[11px]">Resume</button>
                          )}
                          {isActive(b.status) && b.pendingCount > 0 && (
                            <button onClick={() => control(b, 'DRAIN')} disabled={!!busy} className="btn-secondary !py-1 text-[11px]">
                              {busy === `${b.id}:DRAIN` ? 'Sending…' : 'Process queue'}
                            </button>
                          )}
                          {b.failedCount > 0 && (
                            <button onClick={() => control(b, 'RETRY_FAILED')} disabled={!!busy} className="btn-secondary !py-1 text-[11px]">Retry failed</button>
                          )}
                          {isActive(b.status) && (
                            <button onClick={() => control(b, 'CANCEL')} disabled={!!busy} className="text-[11px] text-muted-foreground hover:text-destructive">Cancel</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
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
