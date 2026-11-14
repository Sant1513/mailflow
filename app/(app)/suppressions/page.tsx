'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DateInput } from '@/components/ui/DateInput';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { Download, Plus, X } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadError, loadErrorMessage } from '@/components/ui/LoadError';
import { ListPager } from '@/components/ui/ListPager';
import { BOUNCE_CATEGORIES, CATEGORY_LABEL, isBounceCategory, type BounceCategory } from '@/lib/email/dsn';
import { SUPPRESSION_SORTS, SUPPRESSION_TYPES } from '@/lib/suppressions/filters';

interface Suppression {
  id: string;
  email: string;
  reason: string;
  source: string;
  detail: string | null;
  category: string | null;
  statusCode: string | null;
  remark: string | null;
  createdAt: string;
  orgCopy: boolean;
  addedBy: { name: string | null; email: string } | null;
  campaign: { id: string; name: string } | null;
  recruiterBlast: { id: string; name: string | null } | null;
}

interface SendOption {
  value: string;
  label: string;
  count: number;
}

const SOURCE_LABEL: Record<string, string> = { MANUAL: 'Manual', BOUNCE: 'Bounce', UNSUBSCRIBE: 'Unsubscribe', COMPLAINT: 'Complaint' };
const REASON_LABEL: Record<string, string> = { BOUNCED: 'Bounced', UNSUBSCRIBED: 'Unsubscribed', COMPLAINT: 'Marked as spam' };
const SCOPE_LABEL: Record<string, string> = { own: 'This workspace’s own', org: 'Org-wide copies (teammate’s bounce)' };

const CATEGORY_BADGE: Record<BounceCategory, string> = {
  USER_UNKNOWN: 'badge-danger',
  DOMAIN_NOT_FOUND: 'badge-danger',
  MAILBOX_DISABLED: 'badge-danger',
  OTHER_HARD: 'badge-danger',
  SPAM_BLOCK: 'badge-danger',
  COMPLAINT: 'badge-danger',
  POLICY_BLOCK: 'badge-warning',
  MAILBOX_FULL: 'badge-warning',
  LEFT_COMPANY: 'badge-info',
  MESSAGE_TOO_LARGE: 'badge-neutral',
  TEMPORARY: 'badge-neutral',
};

/** Filters kept in the URL (shareable, survive a reload). */
const FILTER_KEYS = ['q', 'type', 'category', 'source', 'scope', 'from', 'to', 'send', 'sort'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

const IST_DATE = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const IST_TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });

function TypeBadge({ row }: { row: Suppression }) {
  if (isBounceCategory(row.category)) {
    return <span className={`badge ${CATEGORY_BADGE[row.category]}`}>{CATEGORY_LABEL[row.category]}</span>;
  }
  const cls = row.reason === 'UNSUBSCRIBED' ? 'badge-neutral' : 'badge-danger';
  return <span className={`badge ${cls}`}>{REASON_LABEL[row.reason] ?? row.reason}</span>;
}

function SuppressionsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const get = (k: FilterKey) => params.get(k) ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const pageSize = Number(params.get('pageSize')) || 50;

  const [rows, setRows] = useState<Suppression[]>([]);
  const [total, setTotal] = useState(0);
  const [sends, setSends] = useState<SendOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(get('q'));

  // Add form state
  const [showAdd, setShowAdd] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [addReason, setAddReason] = useState<'UNSUBSCRIBED' | 'BOUNCED' | 'COMPLAINT'>('UNSUBSCRIBED');
  const [addDetail, setAddDetail] = useState('');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  /** The filter part of the query string (no paging). */
  const filterQuery = useMemo(() => {
    const q = new URLSearchParams();
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (v) q.set(k, v);
    }
    return q;
  }, [params]);

  const setParams = useCallback(
    (next: Partial<Record<FilterKey | 'page' | 'pageSize', string | number | null>>, resetPage = true) => {
      const q = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v === null || v === '' || v === undefined) q.delete(k);
        else q.set(k, String(v));
      }
      if (resetPage && !('page' in next)) q.delete('page');
      const s = q.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const q = new URLSearchParams(filterQuery);
    q.set('page', String(page));
    q.set('pageSize', String(pageSize));
    const res = await fetch(`/api/suppressions?${q.toString()}`).catch(() => null);
    if (!res || !res.ok) {
      setError(await loadErrorMessage(res, 'suppression list'));
      setLoading(false);
      return;
    }
    const json = await res.json();
    setRows(json.suppressions ?? []);
    setTotal(json.total ?? 0);
    setSends(json.sends ?? []);
    setLoading(false);
  }, [filterQuery, page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  // The search box writes to the URL after a short pause...
  const pushedQ = useRef(params.get('q') ?? '');
  useEffect(() => {
    const q = search.trim();
    if (q === pushedQ.current) return;
    const t = setTimeout(() => {
      pushedQ.current = q;
      setParams({ q: q || null });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  // ...and follows the URL when it changes some other way (back button, Clear all, a chip).
  useEffect(() => {
    const urlQ = params.get('q') ?? '';
    if (urlQ !== pushedQ.current) {
      pushedQ.current = urlQ;
      setSearch(urlQ);
    }
  }, [params]);

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
    load();
  }

  async function handleDelete(row: Suppression) {
    if (!confirm(`Remove ${row.email} from suppression list?`)) return;
    setDeleting(row.id);
    const res = await fetch(`/api/suppressions?id=${row.id}`, { method: 'DELETE' });
    setDeleting(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? 'Could not remove suppression');
      return;
    }
    toast.success(`${row.email} removed`);
    load();
  }

  const sendLabel = (v: string) => sends.find((s) => s.value === v)?.label ?? v;
  const chips: { key: FilterKey; label: string }[] = [];
  if (get('q')) chips.push({ key: 'q', label: `Search: “${get('q')}”` });
  if (get('type')) chips.push({ key: 'type', label: `Type: ${SUPPRESSION_TYPES[get('type') as keyof typeof SUPPRESSION_TYPES] ?? get('type')}` });
  if (get('category')) chips.push({ key: 'category', label: `Category: ${get('category') === 'NONE' ? 'None (unsubscribes, manual)' : isBounceCategory(get('category')) ? CATEGORY_LABEL[get('category') as BounceCategory] : get('category')}` });
  if (get('source')) chips.push({ key: 'source', label: `Source: ${SOURCE_LABEL[get('source')] ?? get('source')}` });
  if (get('scope')) chips.push({ key: 'scope', label: `Scope: ${SCOPE_LABEL[get('scope')] ?? get('scope')}` });
  if (get('from')) chips.push({ key: 'from', label: `From ${get('from')}` });
  if (get('to')) chips.push({ key: 'to', label: `To ${get('to')}` });
  if (get('send')) chips.push({ key: 'send', label: sendLabel(get('send')) });
  if (get('sort') && get('sort') !== 'newest') chips.push({ key: 'sort', label: `Sort: ${SUPPRESSION_SORTS[get('sort') as keyof typeof SUPPRESSION_SORTS] ?? get('sort')}` });
  const filtered = chips.some((c) => c.key !== 'sort');
  const csvHref = `/api/suppressions?${new URLSearchParams([...filterQuery.entries(), ['format', 'csv']]).toString()}`;

  const select = 'input h-9 w-full text-sm';
  const label = 'mb-1 block text-xs font-medium text-muted-foreground';

  if (error && !rows.length) return <LoadError message={error} onRetry={load} />;

  return (
    <div className="p-6">
      <PageHeader
        title="Suppression List"
        description="Emails here are skipped on every future send. Bounces, blocks, “has left the company” replies and spam reports are added automatically and apply to everyone in the organisation; unsubscribes are added when someone clicks Unsubscribe. A full mailbox is added on its second bounce within 30 days; temporary delays never are."
        actions={
          <>
            <a href={csvHref} className="btn-secondary inline-flex items-center gap-1.5" download>
              <Download className="h-4 w-4" /> Download CSV
            </a>
            <button className="btn-primary inline-flex items-center gap-1.5" onClick={() => setShowAdd((v) => !v)}>
              <Plus className="h-4 w-4" /> Add email
            </button>
          </>
        }
      />

      {showAdd && (
        <form onSubmit={handleAdd} className="panel mb-5 flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-48 flex-1">
            <label className={label}>Email address</label>
            <input type="email" required value={addEmail} onChange={(e) => setAddEmail(e.target.value)} placeholder="user@example.com" className="input w-full" />
          </div>
          <div>
            <label className={label}>Reason</label>
            <select value={addReason} onChange={(e) => setAddReason(e.target.value as typeof addReason)} className="input">
              <option value="UNSUBSCRIBED">Unsubscribed</option>
              <option value="BOUNCED">Bounced</option>
              <option value="COMPLAINT">Complaint</option>
            </select>
          </div>
          <div className="min-w-48 flex-1">
            <label className={label}>Detail (optional)</label>
            <input type="text" value={addDetail} onChange={(e) => setAddDetail(e.target.value)} placeholder="e.g. requested via support ticket" className="input w-full" />
          </div>
          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={adding}>{adding ? 'Adding…' : 'Add'}</button>
            <button type="button" className="btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="panel mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
          <div className="sm:col-span-2">
            <label className={label} htmlFor="sup-q">Search</label>
            <input id="sup-q" type="search" placeholder="Email, remark, server message or code…" value={search} onChange={(e) => setSearch(e.target.value)} className="input h-9 w-full" />
          </div>
          <div>
            <label className={label} htmlFor="sup-type">Type</label>
            <select id="sup-type" className={select} value={get('type')} onChange={(e) => setParams({ type: e.target.value || null })}>
              <option value="">All types</option>
              {Object.entries(SUPPRESSION_TYPES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="sup-category">Category</label>
            <select id="sup-category" className={select} value={get('category')} onChange={(e) => setParams({ category: e.target.value || null })}>
              <option value="">All categories</option>
              {BOUNCE_CATEGORIES.filter((c) => c !== 'TEMPORARY' && c !== 'MESSAGE_TOO_LARGE').map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              <option value="NONE">None (unsubscribes, manual, older bounces)</option>
            </select>
          </div>
          <div>
            <label className={label} htmlFor="sup-source">Source</label>
            <select id="sup-source" className={select} value={get('source')} onChange={(e) => setParams({ source: e.target.value || null })}>
              <option value="">All sources</option>
              {Object.entries(SOURCE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="sup-scope">Scope</label>
            <select id="sup-scope" className={select} value={get('scope')} onChange={(e) => setParams({ scope: e.target.value || null })}>
              <option value="">Everything</option>
              <option value="own">{SCOPE_LABEL.own}</option>
              <option value="org">{SCOPE_LABEL.org}</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={label} htmlFor="sup-send">Send / campaign</label>
            <select id="sup-send" className={select} value={get('send')} onChange={(e) => setParams({ send: e.target.value || null })}>
              <option value="">Any send</option>
              {sends.map((s) => <option key={s.value} value={s.value}>{s.label} ({s.count})</option>)}
              {get('send') && !sends.some((s) => s.value === get('send')) && <option value={get('send')}>{get('send')}</option>}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="sup-from">Added from (IST)</label>
            <DateInput id="sup-from" className={select} value={get('from')} max={get('to') || undefined} onChange={(e) => setParams({ from: e.target.value || null })} />
          </div>
          <div>
            <label className={label} htmlFor="sup-to">Added to (IST)</label>
            <DateInput id="sup-to" className={select} value={get('to')} min={get('from') || undefined} onChange={(e) => setParams({ to: e.target.value || null })} />
          </div>
          <div>
            <label className={label} htmlFor="sup-sort">Sort</label>
            <select id="sup-sort" className={select} value={get('sort') || 'newest'} onChange={(e) => setParams({ sort: e.target.value === 'newest' ? null : e.target.value })}>
              {Object.entries(SUPPRESSION_SORTS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-foreground" aria-live="polite">
            {loading ? 'Loading…' : `${total.toLocaleString('en-IN')} ${filtered ? 'matching' : 'suppressed'} address${total !== 1 ? 'es' : ''}`}
          </span>
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setParams({ [c.key]: null })}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-elevated px-2.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
              title="Remove this filter"
            >
              {c.label} <X className="h-3 w-3" />
            </button>
          ))}
          {chips.length > 0 && (
            <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => router.replace(pathname, { scroll: false })}>
              Clear all
            </button>
          )}
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>
      </div>

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-elevated text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Email</th>
                <th className="px-4 py-2 text-left font-medium">Type</th>
                <th className="px-4 py-2 text-left font-medium">Remark / server message</th>
                <th className="px-4 py-2 text-left font-medium">Code</th>
                <th className="px-4 py-2 text-left font-medium">Source</th>
                <th className="px-4 py-2 text-left font-medium">Send</th>
                <th className="px-4 py-2 text-left font-medium">Added by</th>
                <th className="px-4 py-2 text-left font-medium">Date (IST)</th>
                <th className="px-4 py-2 text-left font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {filtered ? 'No addresses match these filters.' : 'No suppressed addresses yet.'}
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.id} className="align-top hover:bg-elevated/40">
                  <td className="px-4 py-2 font-mono text-xs">{row.email}</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <TypeBadge row={row} />
                      {row.orgCopy && <span className="badge badge-neutral" title="Bounced on a teammate's send: blocked for everyone in the organisation">Org-wide</span>}
                    </div>
                  </td>
                  <td className="max-w-sm px-4 py-2">
                    {row.remark && <div className="text-xs text-foreground">{row.remark}</div>}
                    {row.detail && (
                      <div className="mt-0.5 line-clamp-2 break-words text-xs text-faint" title={row.detail}>{row.detail}</div>
                    )}
                    {!row.remark && !row.detail && <span className="text-xs text-faint">{REASON_LABEL[row.reason] ?? row.reason}</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-muted-foreground">{row.statusCode ?? <span className="text-faint">—</span>}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{SOURCE_LABEL[row.source] ?? row.source}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {row.campaign ? (
                      <Link href={`/campaigns/${row.campaign.id}`} className="underline hover:text-foreground">{row.campaign.name}</Link>
                    ) : row.recruiterBlast ? (
                      row.recruiterBlast.name ? (
                        <Link href={`/recruiter-send/${row.recruiterBlast.id}`} className="underline hover:text-foreground">{row.recruiterBlast.name}</Link>
                      ) : (
                        <span className="italic">Deleted recruiter send</span>
                      )
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {row.addedBy ? (
                      <span title={row.addedBy.email}>{row.addedBy.name ?? row.addedBy.email}</span>
                    ) : row.source === 'UNSUBSCRIBE' ? (
                      <span className="italic">The recipient (unsubscribe)</span>
                    ) : row.source === 'BOUNCE' || row.source === 'COMPLAINT' ? (
                      <span className="italic">{row.reason === 'COMPLAINT' ? 'System (spam report)' : row.orgCopy ? 'System (teammate’s bounce)' : 'System (bounce)'}</span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-muted-foreground" title={new Date(row.createdAt).toISOString()}>
                    {IST_DATE.format(new Date(row.createdAt))}
                    <div className="text-faint">{IST_TIME.format(new Date(row.createdAt))}</div>
                  </td>
                  <td className="px-4 py-2">
                    <button onClick={() => handleDelete(row)} disabled={deleting === row.id} className="text-xs text-danger hover:underline disabled:opacity-50">
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ListPager
          page={page}
          pageSize={pageSize}
          total={total}
          noun="addresses"
          className="border-t px-3"
          onPage={(p) => setParams({ page: p }, false)}
          onPageSize={(n) => setParams({ pageSize: n })}
        />
      </div>
    </div>
  );
}

export default function SuppressionsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <SuppressionsView />
    </Suspense>
  );
}
