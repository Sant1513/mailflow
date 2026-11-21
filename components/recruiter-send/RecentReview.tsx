'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Pager } from '@/components/recruiter-send/RecruiterPreview';
import { windowWarning } from '@/lib/recruiterSend/repeatDays';

/**
 * Repeat guard, step 1: recruiters who were already emailed from MailFlow in the last N days are left
 * out by default. This shows each one with the last email they got (subject, date, mailbox, which send),
 * lets the admin tick any number (or everyone matching a search, across pages) and choose
 * "Send again", "Skip" or "Remove from list". Backed by /api/recruiter-blasts/[id]/recent.
 */

interface Row { email: string; name: string | null; sendAgain: boolean; sentAt: string | null; pending: boolean; subject: string; source: string; from: string | null; count: number }
interface Data {
  windowDays: number; exempt: boolean; status: string;
  totals: { recent: number; sendAgain: number; skipped: number };
  matching: number; page: number; pages: number; perPage: number; rows: Row[];
}
type Show = 'all' | 'skipped' | 'included';
type Sort = 'newest' | 'oldest' | 'email';

export interface RecentSummary { windowDays: number; flagged: number; included: number; coolOff?: number }

const DAY_MS = 86_400_000;
const ago = (iso: string | null, pending: boolean): string => {
  if (pending || !iso) return 'queued, not sent yet';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '');
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The amber notice above the steps (so it stays visible when the Recruiters step is folded), right after a list is added. */
export function RecentNotice({ summary, readOnly, onReview }: { summary: RecentSummary | null; readOnly: boolean; onReview: () => void }) {
  const flagged = summary?.flagged ?? 0;
  const included = summary?.included ?? 0;
  const windowDays = summary?.windowDays ?? 0;
  const coolOff = summary?.coolOff ?? 0;
  const showRecent = !!summary && windowDays > 0 && flagged + included > 0;
  if (!summary || (!showRecent && coolOff === 0)) return null;
  return (
    <div className="space-y-2 text-sm">
      {coolOff > 0 && (
        <div className="rounded-md border border-sky-300 bg-sky-50 p-2.5 text-sky-900 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-100" role="status">
          <b>{coolOff.toLocaleString()}</b> recruiter{coolOff === 1 ? ' is' : 's are'} on a cool-off (“do not contact until”) and will not get this email. Change a cool-off on the contact.
        </div>
      )}
      {showRecent && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100" role="status">
          <span className="min-w-0 flex-1">
            {flagged > 0 && <><b>{flagged.toLocaleString()}</b> recruiter{flagged === 1 ? ' was' : 's were'} emailed in the last {windowDays} day{windowDays === 1 ? '' : 's'} and will <b>not</b> get this email.</>}
            {included > 0 && <> {flagged > 0 ? '' : 'All of those were '}<b>{included.toLocaleString()}</b> chosen to get it again.</>}
          </span>
          <button type="button" onClick={onReview} className="rounded border border-amber-400 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:bg-transparent dark:text-amber-100">
            {readOnly ? 'See who' : 'Review and choose'}
          </button>
        </div>
      )}
    </div>
  );
}

/** The window setting, inside the Recruiters step. */
export function RecentWindow({ windowDays, readOnly, onWindow }: { windowDays: number; readOnly: boolean; onWindow: (days: number) => void }) {
  return (
    <div className="mt-3 text-sm">
      {!readOnly && (
        <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          Skip recruiters emailed in the last
          <input
            type="number"
            min={0}
            max={90}
            value={windowDays}
            onChange={(e) => onWindow(Math.min(90, Math.max(0, Math.floor(Number(e.target.value)) || 0)))}
            className="w-16 rounded border bg-background px-1.5 py-0.5 text-foreground"
            aria-label="Days to skip recruiters who were emailed recently (0 turns the check off)"
          />
          days <span className="text-faint">(0 = send to everyone; sends, campaigns, Quick Send and your Inbox replies all count)</span>
        </label>
      )}
      {!readOnly && windowWarning(windowDays) && (
        <p className="mt-1.5 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100" role="status">{windowWarning(windowDays)}</p>
      )}
    </div>
  );
}

export function RecentReview({ blastId, open, onClose, onChanged }: { blastId: string; open: boolean; onClose: () => void; onChanged: () => void }) {
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [sort, setSort] = useState<Sort>('newest');
  const [olderThan, setOlderThan] = useState(7);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  /** "Everyone matching the filters" (all pages), not just the ticked rows. */
  const [allMatching, setAllMatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const t = setTimeout(() => { setQ(query.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [query]);

  // Changing what is shown starts again from page 1 with nothing ticked (a tick must never apply to rows the admin can't see).
  useEffect(() => { setTicked(new Set()); setAllMatching(false); }, [q, show, sort]);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/recruiter-blasts/${blastId}/recent?page=${page}&q=${encodeURIComponent(q)}&show=${show}&sort=${sort}`, { cache: 'no-store', signal: ctrl.signal })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error ?? 'Could not load the list.');
        setData(j);
      })
      .catch((e: unknown) => { if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load the list.'); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [open, blastId, page, q, show, sort, version]);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => searchRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return; }
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

  const act = useCallback(async (action: 'include' | 'skip' | 'remove', scope: { emails: string[] } | { all: true; olderThanDays?: number }) => {
    setBusy(true);
    const filter = 'all' in scope ? { q: q || undefined, show: show === 'all' ? undefined : show } : {};
    const res = await fetch(`/api/recruiter-blasts/${blastId}/recent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, scope: { ...scope, ...filter } }) }).catch(() => null);
    const j = await res?.json().catch(() => ({}));
    setBusy(false);
    if (!res?.ok) { toast.error(j?.error ?? 'Something went wrong.'); return; }
    const n = j.changed as number;
    toast.success(n === 0 ? 'Nobody to change.' : action === 'include' ? `${n.toLocaleString()} will get it again.` : action === 'skip' ? `${n.toLocaleString()} will be skipped.` : `${n.toLocaleString()} removed from this list.`);
    setTicked(new Set());
    setAllMatching(false);
    setVersion((v) => v + 1);
    onChanged();
  }, [blastId, q, show, onChanged]);

  if (!open) return null;

  const readOnly = !!data && data.status !== 'DRAFT';
  const rows = data?.rows ?? [];
  const pageAllTicked = rows.length > 0 && rows.every((r) => ticked.has(r.email));
  const count = allMatching ? data?.matching ?? 0 : ticked.size;
  const scopeNow = (): { emails: string[] } | { all: true } => (allMatching ? { all: true } : { emails: [...ticked] });
  const toggle = (email: string) => { setAllMatching(false); setTicked((s) => { const n = new Set(s); if (n.has(email)) n.delete(email); else n.add(email); return n; }); };
  const togglePage = () => { setAllMatching(false); setTicked((s) => { const n = new Set(s); if (pageAllTicked) rows.forEach((r) => n.delete(r.email)); else rows.forEach((r) => n.add(r.email)); return n; }); };
  const from = data && data.matching ? (data.page - 1) * data.perPage + 1 : 0;
  const to = data ? Math.min(data.matching, from + rows.length - 1) : 0;
  const days = data?.windowDays ?? 10;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="recent-review-title" className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-lg border bg-background shadow-2xl">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5">
          <h2 id="recent-review-title" className="text-sm font-semibold">Recently emailed recruiters</h2>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {data ? `${data.totals.recent.toLocaleString()} in the last ${days} days · ${data.totals.sendAgain.toLocaleString()} will get it again · ${data.totals.skipped.toLocaleString()} skipped` : ''}
            {loading ? ' · loading…' : ''}
          </span>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="rounded border px-2.5 py-1 text-sm hover:bg-elevated">Close</button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
          <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search email, name or subject" aria-label="Search" className="w-full rounded border bg-background px-2 py-1 text-sm sm:w-64" maxLength={200} />
          <select value={show} onChange={(e) => setShow(e.target.value as Show)} aria-label="Show" className="rounded border bg-background px-2 py-1">
            <option value="all">All</option>
            <option value="skipped">Skipped (will not get it)</option>
            <option value="included">Will get it again</option>
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort" className="rounded border bg-background px-2 py-1">
            <option value="newest">Emailed most recently first</option>
            <option value="oldest">Emailed longest ago first</option>
            <option value="email">Email A–Z</option>
          </select>
          <a href={`/api/recruiter-blasts/${blastId}/recent?format=csv&q=${encodeURIComponent(q)}&show=${show}`} className="ml-auto rounded border px-2.5 py-1 hover:bg-elevated">Download list</a>
        </div>

        {!readOnly && data && !data.exempt && data.totals.recent > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs">
            {count > 0 ? (
              <>
                <b>{count.toLocaleString()} selected</b>
                <button type="button" disabled={busy} onClick={() => act('include', scopeNow())} className="rounded bg-primary px-2.5 py-1 font-medium text-primary-foreground disabled:opacity-50">Send again to selected</button>
                <button type="button" disabled={busy} onClick={() => act('skip', scopeNow())} className="rounded border px-2.5 py-1 hover:bg-elevated disabled:opacity-50">Skip selected</button>
                <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Remove ${count.toLocaleString()} recruiter${count === 1 ? '' : 's'} from this send's list?`)) act('remove', scopeNow()); }} className="rounded border border-red-300 px-2.5 py-1 text-red-700 hover:bg-red-50 disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-950">Remove from list</button>
                <button type="button" onClick={() => { setTicked(new Set()); setAllMatching(false); }} className="text-muted-foreground hover:underline">Clear</button>
              </>
            ) : (
              <>
                <span className="text-muted-foreground">Tick recruiters below, or:</span>
                <button type="button" disabled={busy || !data.totals.skipped} onClick={() => { if (window.confirm(`Send again to all ${data.matching.toLocaleString()} listed${q || show !== 'all' ? ' (matching your search)' : ''}?`)) act('include', { all: true }); }} className="rounded border px-2.5 py-1 hover:bg-elevated disabled:opacity-50">Send again to all{q || show !== 'all' ? ' listed' : ''}</button>
                <span className="flex items-center gap-1">
                  <button type="button" disabled={busy} onClick={() => act('include', { all: true, olderThanDays: olderThan })} className="rounded border px-2.5 py-1 hover:bg-elevated disabled:opacity-50">Send again to those emailed {olderThan}+ days ago</button>
                  <select value={olderThan} onChange={(e) => setOlderThan(Number(e.target.value))} aria-label="Days since last email" className="rounded border bg-background px-1 py-1">
                    {[3, 5, 7, 9].filter((d) => d < days).map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </span>
                <button type="button" disabled={busy || !data.totals.sendAgain} onClick={() => act('skip', { all: true })} className="rounded border px-2.5 py-1 hover:bg-elevated disabled:opacity-50">Skip all listed</button>
              </>
            )}
          </div>
        )}
        {!readOnly && pageAllTicked && data && data.matching > rows.length && !allMatching && (
          <div className="border-b bg-sky-50 px-3 py-1.5 text-xs text-sky-900 dark:bg-sky-950 dark:text-sky-100">
            All {rows.length} on this page are selected. <button type="button" onClick={() => setAllMatching(true)} className="font-medium underline">Select all {data.matching.toLocaleString()} matching</button>
          </div>
        )}
        {allMatching && data && <div className="border-b bg-sky-50 px-3 py-1.5 text-xs text-sky-900 dark:bg-sky-950 dark:text-sky-100">All {data.matching.toLocaleString()} matching are selected, across every page.</div>}

        <div className="min-h-[12rem] flex-1 overflow-auto">
          {error ? (
            <p className="p-4 text-sm text-red-600">{error}</p>
          ) : !data ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : data.exempt ? (
            <p className="p-4 text-sm text-muted-foreground">Follow-ups are meant for recruiters who were emailed before, so the repeat check does not apply to them.</p>
          ) : data.windowDays === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">The repeat check is off for this send (0 days).</p>
          ) : data.totals.recent === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Nobody in this list was emailed in the last {data.windowDays} days.</p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Nothing matches that search.</p>
          ) : (
            <table className={`w-full text-sm ${loading ? 'opacity-60' : ''}`}>
              <thead className="sticky top-0 z-10 bg-card text-left text-xs text-muted-foreground shadow-[0_1px_0_hsl(var(--border))]">
                <tr>
                  {!readOnly && <th scope="col" className="w-8 px-2 py-1.5"><input type="checkbox" checked={pageAllTicked} onChange={togglePage} aria-label="Select everyone on this page" /></th>}
                  <th scope="col" className="px-2 py-1.5 font-medium">Recruiter</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Last email they got</th>
                  <th scope="col" className="whitespace-nowrap px-2 py-1.5 font-medium">When</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">From</th>
                  <th scope="col" className="whitespace-nowrap px-2 py-1.5 font-medium">This send</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.email} className={`border-t border-border-subtle align-top hover:bg-elevated ${ticked.has(r.email) || allMatching ? 'bg-primary/5' : ''}`}>
                    {!readOnly && <td className="px-2 py-1.5"><input type="checkbox" checked={allMatching || ticked.has(r.email)} onChange={() => toggle(r.email)} aria-label={`Select ${r.email}`} /></td>}
                    <td className="min-w-[11rem] max-w-[16rem] px-2 py-1.5">
                      <div className="truncate font-medium" title={r.email}>{r.email}</div>
                      {r.name && <div className="truncate text-xs text-muted-foreground">{r.name}</div>}
                    </td>
                    <td className="min-w-[16rem] max-w-[26rem] px-2 py-1.5">
                      <div className="break-words font-medium" title={r.subject}>{r.subject.length > 120 ? `${r.subject.slice(0, 117)}…` : r.subject || '(no subject)'}</div>
                      <div className="text-xs text-muted-foreground">{r.source}{r.count > 1 ? ` · ${r.count} emails in ${days} days` : ''}</div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-xs"><div>{ago(r.sentAt, r.pending)}</div><div className="text-muted-foreground">{when(r.sentAt)}</div></td>
                    <td className="max-w-[12rem] truncate px-2 py-1.5 text-xs text-muted-foreground" title={r.from ?? undefined}>{r.from ?? '—'}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      {readOnly ? (
                        <span className="text-xs text-muted-foreground">{r.sendAgain ? 'got it again' : 'skipped'}</span>
                      ) : r.sendAgain ? (
                        <button type="button" disabled={busy} onClick={() => act('skip', { emails: [r.email] })} className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 hover:bg-green-200 disabled:opacity-50 dark:bg-green-950 dark:text-green-200" title="Click to skip this recruiter again">Sending again ✓</button>
                      ) : (
                        <button type="button" disabled={busy} onClick={() => act('include', { emails: [r.email] })} className="rounded border px-2 py-0.5 text-xs hover:bg-elevated disabled:opacity-50" title="Click to send them this email anyway">Skipped · send again</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {data && data.matching > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
            <span className="text-xs text-muted-foreground">Showing {from.toLocaleString()}–{to.toLocaleString()} of {data.matching.toLocaleString()}</span>
            <Pager page={data.page} pages={data.pages} onPage={setPage} label="Recently emailed pages" />
          </div>
        )}
      </div>
    </div>
  );
}
