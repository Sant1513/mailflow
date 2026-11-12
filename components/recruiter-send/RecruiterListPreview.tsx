'use client';

import { useEffect, useRef, useState } from 'react';
import { Pager } from '@/components/recruiter-send/RecruiterPreview';

/**
 * "Preview list": the send's recruiters as a table with every uploaded column (email first),
 * paged 50 at a time from GET /api/recruiter-blasts/[id]/recipients, with a search on email and
 * name. An accessible modal: role=dialog, focus kept inside, Escape / backdrop close, focus goes
 * back to the button that opened it.
 */

interface Row { email: string; name: string | null; status: string; data: Record<string, unknown> }
interface PageData { columns: string[]; emailColumn: string | null; status: string; page: number; pages: number; total: number; recipients: Row[] }

const STATUS_LABEL: Record<string, string> = { PENDING: 'queued', QUEUED: 'queued', SENT: 'sent', BOUNCED: 'bounced', SKIPPED: 'skipped', FAILED: 'failed' };
const STATUS_TONE: Record<string, string> = {
  SENT: 'text-green-700 dark:text-green-400',
  BOUNCED: 'text-red-600',
  FAILED: 'text-red-600',
  SKIPPED: 'text-muted-foreground',
};
type Fit = 'short' | 'wide' | 'full';
const FIT_KEY = 'mailflow.recruiterList.fit';
/** Cell width per "Text" choice: cut at 22rem, cut at 44rem, or wrap so every value shows in full. */
const FIT_CELL: Record<Fit, string> = {
  short: 'max-w-[22rem] truncate',
  wide: 'max-w-[44rem] truncate',
  full: 'min-w-[16rem] max-w-[40rem] whitespace-normal break-all',
};
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function RecruiterListPreview({ blastId, open, onClose, version }: { blastId: string; open: boolean; onClose: () => void; version?: string | number }) {
  const [page, setPage] = useState(1);
  // Long values (UTM links): cut short, wider cells, or shown in full. Remembered on this browser.
  const [fit, setFit] = useState<Fit>(() => {
    try {
      const v = localStorage.getItem(FIT_KEY);
      return v === 'wide' || v === 'full' ? v : 'short';
    } catch {
      return 'short';
    }
  });
  const chooseFit = (f: Fit) => {
    setFit(f);
    try {
      localStorage.setItem(FIT_KEY, f);
    } catch {
      /* private mode: just this time */
    }
  };
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // The search waits for a pause in typing, then starts again from page 1.
  useEffect(() => {
    const t = setTimeout(() => { setQ(query.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/recruiter-blasts/${blastId}/recipients?page=${page}&q=${encodeURIComponent(q)}`, { cache: 'no-store', signal: ctrl.signal })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error ?? 'Could not load the list.');
        setData(j);
        scrollRef.current?.scrollTo({ top: 0 });
      })
      .catch((e: unknown) => { if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load the list.'); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [open, blastId, page, q, version]);

  // Opening: remember where focus was, focus the search, stop the page behind from scrolling.
  // Closing: focus goes back.
  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => searchRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = dialogRef.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      returnTo.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const columns = data?.columns ?? [];
  const emailColumn = data?.emailColumn ?? null;
  // Plain address lists have no columns: show the address and name.
  const others = columns.length ? columns.filter((c) => c !== emailColumn) : ['Name'];
  const emailHeader = emailColumn ?? 'Email';
  const showStatus = !!data && data.status !== 'DRAFT';
  const cell = (r: Row, c: string) => {
    if (!columns.length && c === 'Name') return r.name ?? '';
    const v = r.data[c];
    return v == null ? '' : String(v);
  };
  const from = data && data.total ? (data.page - 1) * 50 + 1 : 0;
  const to = data ? Math.min(data.total, from + data.recipients.length - 1) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="recruiter-list-title" className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-lg border bg-background shadow-2xl">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5">
          <h2 id="recruiter-list-title" className="text-sm font-semibold">Recruiters in this send</h2>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {data ? `${data.total.toLocaleString()} ${q ? `matching “${q}”` : `recruiter${data.total === 1 ? '' : 's'}`}${columns.length ? ` · ${columns.length} column${columns.length === 1 ? '' : 's'}` : ''}` : ''}
            {loading ? ' · loading…' : ''}
          </span>
          <span className="flex-1" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search email or name"
            aria-label="Search recruiters by email or name"
            className="w-full rounded border bg-background px-2 py-1 text-sm sm:w-64"
            maxLength={200}
          />
          <div role="radiogroup" aria-label="How much of long values to show" className="flex items-center gap-0.5 rounded border p-0.5 text-xs">
            <span className="px-1.5 text-muted-foreground">Text</span>
            {(['short', 'wide', 'full'] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={fit === f}
                onClick={() => chooseFit(f)}
                className={`rounded px-2 py-0.5 ${fit === f ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-elevated'}`}
                title={f === 'short' ? 'Cut long values short' : f === 'wide' ? 'Wider cells' : 'Show every value in full (wraps)'}
              >
                {f === 'short' ? 'Short' : f === 'wide' ? 'Wide' : 'Full'}
              </button>
            ))}
          </div>
          <button type="button" onClick={onClose} className="rounded border px-2.5 py-1 text-sm hover:bg-elevated" aria-label="Close the list">Close</button>
        </div>
        <div ref={scrollRef} className="min-h-[12rem] flex-1 overflow-auto">
          {error ? (
            <p className="p-4 text-sm text-red-600">{error}</p>
          ) : !data ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : data.recipients.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{q ? 'No recruiter matches that search.' : 'No recruiters in this send yet.'}</p>
          ) : (
            <table className={`w-full text-sm ${loading ? 'opacity-60' : ''}`}>
              <thead className="sticky top-0 z-10 bg-card text-left text-xs text-muted-foreground shadow-[0_1px_0_hsl(var(--border))]">
                <tr>
                  <th scope="col" className="whitespace-nowrap px-2 py-1.5 font-medium">#</th>
                  <th scope="col" className="whitespace-nowrap bg-primary/10 px-2 py-1.5 font-semibold text-foreground">{emailHeader}</th>
                  {others.map((c) => <th key={c} scope="col" className="whitespace-nowrap px-2 py-1.5 font-medium">{c}</th>)}
                  {showStatus && <th scope="col" className="whitespace-nowrap px-2 py-1.5 font-medium">Status</th>}
                </tr>
              </thead>
              <tbody>
                {data.recipients.map((r, i) => (
                  <tr key={r.email} className="border-t border-border-subtle align-top hover:bg-elevated">
                    <td className="whitespace-nowrap px-2 py-1 text-xs text-muted-foreground">{(from + i).toLocaleString()}</td>
                    <td className="whitespace-nowrap bg-primary/5 px-2 py-1 font-medium">{r.email}</td>
                    {others.map((c) => {
                      const v = cell(r, c);
                      return <td key={c} className={`px-2 py-1 align-top ${FIT_CELL[fit]}`} title={fit !== 'full' && v.length > 40 ? v : undefined}>{v || <span className="text-muted-foreground">—</span>}</td>;
                    })}
                    {showStatus && <td className={`whitespace-nowrap px-2 py-1 text-xs ${STATUS_TONE[r.status] ?? ''}`}>{STATUS_LABEL[r.status] ?? r.status.toLowerCase()}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {data && data.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
            <span className="text-xs text-muted-foreground">Showing {from.toLocaleString()}–{to.toLocaleString()} of {data.total.toLocaleString()}</span>
            <Pager page={data.page} pages={data.pages} onPage={setPage} label="Recruiter list pages" />
          </div>
        )}
      </div>
    </div>
  );
}
