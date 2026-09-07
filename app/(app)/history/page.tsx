'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ExplainButton } from '@/components/ai/ExplainButton';

interface SentItem {
  id: string;
  toEmail: string;
  subject: string;
  status: string;
  sendReason: string | null;
  skipReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  sentAt: string | null;
  createdAt: string;
  gmailThreadId: string | null;
  campaign: { id: string; name: string };
  batch: { id: string; label: string };
  record: { id: string; contactId: string | null; conversationId: string | null } | null;
  templateVersion: { version: number };
}

interface ReceivedItem {
  id: string;
  senderEmail: string;
  senderName: string | null;
  subject: string | null;
  snippet: string | null;
  classification: string;
  classificationConfidence: number | null;
  aiIntent: string | null;
  receivedAt: string | null;
  createdAt: string;
  isRead: boolean;
  conversation: { id: string; subject: string; status: string; contact: { id: string; name: string | null } };
}

const SENT_BADGE: Record<string, string> = { SENT: 'badge-success', FAILED: 'badge-danger', SKIPPED: 'badge-neutral', QUEUED: 'badge-info', SENDING: 'badge-info', CANCELLED: 'badge-neutral' };
const CLASS_BADGE: Record<string, string> = { HUMAN_REPLY: 'badge-success', BOUNCE: 'badge-danger', DELIVERY_FAILURE: 'badge-danger', OUT_OF_OFFICE: 'badge-warning', AUTO_REPLY: 'badge-neutral', UNKNOWN: 'badge-neutral' };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** §61/§126 immutable email history for the workspace: everything sent, everything received. */
export default function HistoryPage() {
  const [direction, setDirection] = useState<'sent' | 'received'>('sent');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<(SentItem | ReceivedItem)[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [meta, setMeta] = useState({ total: 0, page: 1, pageCount: 1 });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ direction, page: String(page) });
    if (q.trim()) qs.set('q', q.trim());
    if (status) qs.set('status', status);
    const res = await fetch(`/api/history?${qs}`);
    if (!res.ok) {
      toast.error('Could not load history');
      setLoading(false);
      return;
    }
    const json = await res.json();
    setItems(json.items ?? []);
    setCounts(json.counts ?? {});
    setMeta({ total: json.total, page: json.page, pageCount: json.pageCount });
    setLoading(false);
  }, [direction, q, status, page]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const statusOptions = direction === 'sent' ? ['SENT', 'FAILED', 'SKIPPED', 'QUEUED', 'SENDING', 'CANCELLED'] : ['HUMAN_REPLY', 'BOUNCE', 'DELIVERY_FAILURE', 'OUT_OF_OFFICE', 'AUTO_REPLY', 'UNKNOWN'];

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow mb-2">Records are immutable</div>
          <h1 className="font-heading text-2xl font-bold tracking-tight">History</h1>
          <p className="mt-1 text-sm text-muted-foreground">Every email this workspace sent or received, exactly as it happened (§126).</p>
        </div>
        <div className="flex rounded-full border border-border bg-card p-1">
          {(['sent', 'received'] as const).map((d) => (
            <button
              key={d}
              onClick={() => {
                setDirection(d);
                setStatus('');
                setPage(1);
              }}
              className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${direction === d ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          placeholder={direction === 'sent' ? 'Search address, subject, campaign, error…' : 'Search sender, subject, text…'}
          className="w-full !py-1.5 text-sm sm:w-72"
        />
        <div className="flex flex-wrap gap-1">
          <button onClick={() => { setStatus(''); setPage(1); }} className={`badge ${status === '' ? 'badge-info' : 'badge-neutral'} cursor-pointer`}>all {meta.total ? `· ${Object.values(counts).reduce((a, b) => a + b, 0)}` : ''}</button>
          {statusOptions.filter((s) => counts[s]).map((s) => (
            <button key={s} onClick={() => { setStatus(status === s ? '' : s); setPage(1); }} className={`badge ${status === s ? 'badge-info' : 'badge-neutral'} cursor-pointer`}>
              {s.replace(/_/g, ' ').toLowerCase()} · {counts[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="panel overflow-hidden">
        {loading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{direction === 'sent' ? 'Nothing has been sent yet.' : 'Nothing has been received yet — replies appear after Gmail sync.'}</p>
        ) : direction === 'sent' ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">To</th>
                  <th className="px-4 py-2">Subject</th>
                  <th className="hidden px-4 py-2 md:table-cell">Campaign</th>
                  <th className="px-4 py-2">Outcome</th>
                  <th className="hidden px-4 py-2 lg:table-cell">When</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {(items as SentItem[]).map((j) => (
                  <tr key={j.id} className="border-t border-border-subtle align-top">
                    <td className="px-4 py-3">
                      {j.record?.contactId ? <Link href={`/contacts/${j.record.contactId}`} className="hover:text-primary">{j.toEmail}</Link> : j.toEmail}
                    </td>
                    <td className="max-w-[320px] truncate px-4 py-3" title={j.subject}>{j.subject}</td>
                    <td className="hidden px-4 py-3 text-xs md:table-cell">
                      <Link href={`/campaigns/${j.campaign.id}`} className="hover:text-primary">{j.campaign.name}</Link>
                      <div className="text-faint">{j.batch.label} · template v{j.templateVersion.version}</div>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className={`badge ${SENT_BADGE[j.status] ?? 'badge-neutral'}`}>{j.status.toLowerCase()}</span>
                      {(j.errorMessage || j.skipReason) && <div className="mt-1 max-w-[260px] truncate text-faint" title={j.errorMessage ?? j.skipReason ?? ''}>{j.errorMessage ?? j.skipReason}</div>}
                      {j.retryCount > 0 && <div className="text-faint">{j.retryCount} retr{j.retryCount === 1 ? 'y' : 'ies'}</div>}
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-muted-foreground lg:table-cell">{when(j.sentAt ?? j.createdAt)}</td>
                    <td className="relative px-4 py-3 text-right text-xs">
                      {j.record?.conversationId && <Link href={`/inbox/${j.record.conversationId}`} className="mr-2 text-muted-foreground hover:text-primary">Thread</Link>}
                      <ExplainButton request={{ action: 'explain_send', emailJobId: j.id }} label="Why?" className="text-[11px] text-muted-foreground hover:text-primary" compact />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">From</th>
                  <th className="px-4 py-2">Message</th>
                  <th className="px-4 py-2">Classified as</th>
                  <th className="hidden px-4 py-2 lg:table-cell">Received</th>
                </tr>
              </thead>
              <tbody>
                {(items as ReceivedItem[]).map((m) => (
                  <tr key={m.id} className="border-t border-border-subtle align-top">
                    <td className="px-4 py-3">
                      <Link href={`/contacts/${m.conversation.contact.id}`} className="font-medium hover:text-primary">{m.senderName || m.conversation.contact.name || m.senderEmail}</Link>
                      <div className="text-xs text-faint">{m.senderEmail}</div>
                    </td>
                    <td className="max-w-[420px] px-4 py-3">
                      <Link href={`/inbox/${m.conversation.id}`} className={`block truncate hover:text-primary ${m.isRead ? '' : 'font-semibold'}`} title={m.subject ?? ''}>{m.subject || m.conversation.subject || '(no subject)'}</Link>
                      <div className="truncate text-xs text-faint" title={m.snippet ?? ''}>{m.snippet}</div>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className={`badge ${CLASS_BADGE[m.classification] ?? 'badge-neutral'}`}>{m.classification.replace(/_/g, ' ').toLowerCase()}</span>
                      {m.aiIntent && <div className="mt-1 text-faint">AI: {m.aiIntent.replace(/_/g, ' ').toLowerCase()}</div>}
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-muted-foreground lg:table-cell">{when(m.receivedAt ?? m.createdAt)}</td>
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
          <span>Page {meta.page} of {meta.pageCount} · {meta.total} rows</span>
          <button onClick={() => setPage((p) => Math.min(meta.pageCount, p + 1))} disabled={page >= meta.pageCount} className="btn-secondary !py-1 text-[11px]">Next ›</button>
        </div>
      )}
    </div>
  );
}
