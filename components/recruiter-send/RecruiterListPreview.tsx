'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, Check, Copy, Pencil, Plus, Trash2, Undo2, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Pager } from '@/components/recruiter-send/RecruiterPreview';

/**
 * "Preview list": the send's recruiters as a table with every uploaded column (email first), paged 50 at a time from
 * GET /api/recruiter-blasts/[id]/recipients, with a search on email and name. A draft can also be edited by hand:
 * tick rows (or "select all N matching"), delete them with Undo, edit a row in place, add one recruiter or paste several.
 * Edits go through /recipients/items. An accessible modal: role=dialog, focus kept inside, Escape (cancels an edit first) /
 * backdrop close, focus goes back to the button that opened it.
 */

interface Row { id: string; email: string; name: string | null; status: string; data: Record<string, unknown> }
interface PageData {
  columns: string[]; emailColumn: string | null; status: string; page: number; pages: number; total: number; recipients: Row[];
  sort?: string; dir?: 'asc' | 'desc'; canEdit?: boolean; canDelete?: boolean;
}
interface UndoRow { email: string; name: string | null; data?: Record<string, unknown> }

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

/** "Asha <asha@acme.com>", one per line or separated by commas/semicolons/spaces → rows to add. */
export function parsePastedRecruiters(text: string): { email: string; name?: string }[] {
  const out: { email: string; name?: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const emails = line.match(/[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
    if (!emails.length) { out.push({ email: line.slice(0, 120) }); continue; } // reported as invalid by the server
    const name = emails.length === 1 ? line.replace(emails[0]!, '').replace(/[<>"(),;\t]/g, ' ').replace(/\s+/g, ' ').trim() : '';
    for (const e of emails) out.push({ email: e, ...(name && name.length <= 120 ? { name } : {}) });
  }
  return out;
}

export function RecruiterListPreview({ blastId, open, onClose, version, onChanged }: { blastId: string; open: boolean; onClose: () => void; version?: string | number; onChanged?: () => void }) {
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
  const [sort, setSort] = useState<{ key: 'order' | 'email' | 'name' | 'status'; dir: 'asc' | 'desc' }>({ key: 'order', dir: 'asc' });
  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // Selection survives paging: id → email. `allMatching` = every row of the current search, not only the ticked ones.
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [allMatching, setAllMatching] = useState(false);
  const [editing, setEditing] = useState<{ id: string; values: Record<string, string> } | null>(null);
  const [adding, setAdding] = useState<null | 'one' | 'paste'>(null);
  const [addValues, setAddValues] = useState<Record<string, string>>({});
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);
  // Domain filter: the applied domains, and the panel to search / tick domains.
  const [domainFilter, setDomainFilter] = useState<string[]>([]);
  const [domainPanel, setDomainPanel] = useState(false);
  const [domainQ, setDomainQ] = useState('');
  const [domainList, setDomainList] = useState<{ domain: string; count: number }[]>([]);
  const [domainTick, setDomainTick] = useState<Set<string>>(new Set());
  const [undo, setUndo] = useState<{ rows: UndoRow[]; label: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const addingRef = useRef(adding);
  addingRef.current = adding;

  // The search waits for a pause in typing, then starts again from page 1.
  useEffect(() => {
    const t = setTimeout(() => { setQ(query.trim()); setPage(1); setPicked(new Map()); setAllMatching(false); }, 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/recruiter-blasts/${blastId}/recipients?page=${page}&q=${encodeURIComponent(q)}&sort=${sort.key}&dir=${sort.dir}&domain=${encodeURIComponent(domainFilter.join(','))}`, { cache: 'no-store', signal: ctrl.signal })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error ?? 'Could not load the list.');
        // A page that emptied (everything on the last page deleted): go back one.
        if (j.recipients?.length === 0 && j.page > 1) { setPage(j.pages); return; }
        setData(j);
        scrollRef.current?.scrollTo({ top: 0 });
      })
      .catch((e: unknown) => { if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load the list.'); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [open, blastId, page, q, sort, version, reload, domainFilter]);

  // The domains panel: every domain in the list with its count, searchable.
  useEffect(() => {
    if (!open || !domainPanel) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/recruiter-blasts/${blastId}/recipients?domains=1&dq=${encodeURIComponent(domainQ.trim())}`, { cache: 'no-store', signal: ctrl.signal })
        .then((r) => r.json())
        .then((j) => setDomainList(j.domains ?? []))
        .catch(() => undefined);
    }, 200);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [open, domainPanel, domainQ, blastId, reload]);

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
        // Escape first backs out of an edit or the add form; only then closes the list.
        if (editingRef.current) { setEditing(null); return; }
        if (addingRef.current) { setAdding(null); return; }
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

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 12_000);
    return () => clearTimeout(t);
  }, [undo]);

  const api = useCallback(async (method: 'POST' | 'PATCH' | 'DELETE', body: unknown) => {
    const res = await fetch(`/api/recruiter-blasts/${blastId}/recipients/items`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error ?? 'That did not work.');
    return j;
  }, [blastId]);
  const changed = () => { setReload((n) => n + 1); onChanged?.(); };

  if (!open) return null;

  const columns = data?.columns ?? [];
  const emailColumn = data?.emailColumn ?? null;
  // Plain address lists have no columns: show the address and name.
  const others = columns.length ? columns.filter((c) => c !== emailColumn) : ['Name'];
  const emailHeader = emailColumn ?? 'Email';
  const showStatus = !!data && data.status !== 'DRAFT';
  const canEdit = !!data?.canEdit;
  const canDelete = !!data?.canDelete;
  const cell = (r: Row, c: string) => {
    if (!columns.length && c === 'Name') return r.name ?? '';
    const v = r.data[c];
    return v == null ? '' : String(v);
  };
  const from = data && data.total ? (data.page - 1) * 50 + 1 : 0;
  const to = data ? Math.min(data.total, from + data.recipients.length - 1) : 0;
  const rows = data?.recipients ?? [];
  const pageAllPicked = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const selectedCount = allMatching ? data?.total ?? 0 : picked.size;

  const toggleRow = (r: Row) => {
    setAllMatching(false);
    setPicked((m) => { const n = new Map(m); n.has(r.id) ? n.delete(r.id) : n.set(r.id, r.email); return n; });
  };
  const togglePage = () => {
    setAllMatching(false);
    setPicked((m) => {
      const n = new Map(m);
      if (pageAllPicked) rows.forEach((r) => n.delete(r.id));
      else rows.forEach((r) => n.set(r.id, r.email));
      return n;
    });
  };
  const clearSelection = () => { setPicked(new Map()); setAllMatching(false); };
  const applyDomains = (list: string[]) => { setDomainFilter(list); setPage(1); clearSelection(); };
  const toggleDomain = (d: string) => setDomainTick((s) => { const n = new Set(s); n.has(d) ? n.delete(d) : n.add(d); return n; });
  const tickedCount = domainList.filter((d) => domainTick.has(d.domain)).reduce((s, d) => s + d.count, 0);
  async function deleteDomains() {
    const list = [...domainTick];
    if (!list.length) return;
    if (!window.confirm(`Delete every recruiter at ${list.length === 1 ? list[0] : `these ${list.length} domains`} (${tickedCount.toLocaleString()} in this list)? You can undo right after.`)) return;
    await deleteRows({ all: true, q: '', domains: list }, `${tickedCount.toLocaleString()} deleted from ${list.length === 1 ? list[0] : `${list.length} domains`}`);
    setDomainTick(new Set());
    setDomainFilter((f) => f.filter((d) => !list.includes(d)));
  }
  const sortBy = (key: 'order' | 'email' | 'name' | 'status') => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
    setPage(1);
  };
  const SortIcon = ({ k }: { k: string }) => (sort.key !== k ? <ChevronsUpDown className="h-3 w-3 opacity-40" /> : sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />);

  async function deleteRows(scope: { ids: string[] } | { all: true; q: string; domains?: string[] }, label: string) {
    setBusy(true);
    try {
      const j = await api('DELETE', scope);
      clearSelection();
      setEditing(null);
      setUndo(j.undo?.length ? { rows: j.undo, label } : null);
      toast.success(`${j.deleted.toLocaleString()} deleted · ${j.remaining.toLocaleString()} left`);
      changed();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete.');
    } finally { setBusy(false); }
  }
  function deleteSelected() {
    const n = selectedCount;
    if (!n) return;
    const what = allMatching ? `all ${n.toLocaleString()} recruiters ${q || domainFilter.length ? 'matching this filter' : 'in this list'}` : `${n.toLocaleString()} recruiter${n === 1 ? '' : 's'}`;
    if ((n > 1 || allMatching) && !window.confirm(`Delete ${what} from this send? You can undo right after.`)) return;
    void deleteRows(allMatching ? { all: true, q, domains: domainFilter } : { ids: [...picked.keys()] }, `${n.toLocaleString()} deleted`);
  }
  async function undoDelete() {
    if (!undo) return;
    setBusy(true);
    try {
      const j = await api('POST', { rows: undo.rows.slice(0, 1000) });
      toast.success(`${j.added.toLocaleString()} put back`);
      setUndo(null);
      changed();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not undo.');
    } finally { setBusy(false); }
  }
  async function copyEmails() {
    const emails = [...picked.values()];
    try { await navigator.clipboard.writeText(emails.join('\n')); toast.success(`${emails.length.toLocaleString()} email${emails.length === 1 ? '' : 's'} copied`); } catch { toast.error('Could not copy.'); }
  }
  function startEdit(r: Row) {
    const values: Record<string, string> = { __email: r.email };
    for (const c of others) values[c] = cell(r, c);
    setEditing({ id: r.id, values });
    setAdding(null);
  }
  async function saveEdit() {
    if (!editing) return;
    setBusy(true);
    try {
      const { __email, ...rest } = editing.values;
      const body = columns.length ? { id: editing.id, email: __email, data: rest } : { id: editing.id, email: __email, name: rest.Name ?? '' };
      await api('PATCH', body);
      setEditing(null);
      toast.success('Saved');
      changed();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save.');
    } finally { setBusy(false); }
  }
  async function addOne() {
    const { __email, ...rest } = addValues;
    if (!__email?.trim()) { toast.error('Type the email address.'); return; }
    setBusy(true);
    try {
      const j = await api('POST', { rows: [columns.length ? { email: __email, data: rest } : { email: __email, name: rest.Name ?? '' }] });
      if (j.added) { toast.success(`${__email.trim()} added`); setAddValues({}); changed(); }
      else toast.error(j.duplicates?.length ? `${__email.trim()} is already in this list.` : j.invalid?.[0]?.reason ?? 'Could not add.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add.');
    } finally { setBusy(false); }
  }
  async function addPasted() {
    const parsed = parsePastedRecruiters(pasteText);
    if (!parsed.length) { toast.error('Paste one email per line.'); return; }
    setBusy(true);
    try {
      let added = 0, dup = 0, bad = 0;
      for (let i = 0; i < parsed.length; i += 1000) {
        const j = await api('POST', { rows: parsed.slice(i, i + 1000) });
        added += j.added; dup += j.duplicates.length; bad += j.invalid.length;
      }
      toast.success(`${added.toLocaleString()} added${dup ? ` · ${dup.toLocaleString()} already in the list` : ''}${bad ? ` · ${bad.toLocaleString()} not valid` : ''}`);
      if (added) { setPasteText(''); setAdding(null); changed(); }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add.');
    } finally { setBusy(false); }
  }

  const input = 'w-full min-w-[8rem] rounded border bg-background px-1.5 py-0.5 text-sm';
  const onEnter = (fn: () => void) => (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); fn(); } };

  // In a portal on <body>: a parent with a transform / filter / containment would otherwise trap the overlay inside its own box.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="recruiter-list-title" className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-lg border bg-background shadow-2xl">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5">
          <h2 id="recruiter-list-title" className="text-sm font-semibold">Recruiters in this send</h2>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {data ? `${data.total.toLocaleString()} ${q || domainFilter.length ? `matching${q ? ` “${q}”` : ''}${domainFilter.length ? ` ${domainFilter.length} domain${domainFilter.length === 1 ? '' : 's'}` : ''}` : `recruiter${data.total === 1 ? '' : 's'}`}${columns.length ? ` · ${columns.length} column${columns.length === 1 ? '' : 's'}` : ''}` : ''}
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
          <button type="button" onClick={() => setDomainPanel((v) => !v)} aria-expanded={domainPanel} data-domains-button className={`rounded border px-2.5 py-1 text-sm hover:bg-elevated ${domainFilter.length ? 'border-primary text-primary' : ''}`}>
            Domains{domainFilter.length ? ` (${domainFilter.length})` : ''}
          </button>
          {canEdit && (
            <div className="flex items-center gap-1" data-add-menu>
              <button type="button" onClick={() => { setAdding(adding === 'one' ? null : 'one'); setEditing(null); }} className="inline-flex items-center gap-1 rounded border px-2.5 py-1 text-sm hover:bg-elevated" aria-expanded={adding === 'one'}><Plus className="h-3.5 w-3.5" /> Add recruiter</button>
              <button type="button" onClick={() => { setAdding(adding === 'paste' ? null : 'paste'); setEditing(null); }} className="rounded border px-2.5 py-1 text-sm hover:bg-elevated" aria-expanded={adding === 'paste'}>Paste emails</button>
            </div>
          )}
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

        {/* Applied domain filter */}
        {domainFilter.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5 text-xs" data-domain-chips>
            <span className="text-muted-foreground">Only domains:</span>
            {domainFilter.map((d) => (
              <span key={d} className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5">{d}<button type="button" aria-label={`Remove ${d} from the filter`} onClick={() => applyDomains(domainFilter.filter((x) => x !== d))}><X className="h-3 w-3" /></button></span>
            ))}
            <button type="button" onClick={() => applyDomains([])} className="text-primary hover:underline">Clear</button>
          </div>
        )}
        {/* Domains panel: search, tick, show only / delete */}
        {domainPanel && (
          <div className="border-b bg-muted/40 px-3 py-2" data-domains-panel>
            <div className="flex flex-wrap items-center gap-2">
              <input autoFocus type="search" value={domainQ} onChange={(e) => setDomainQ(e.target.value)} placeholder="Search domains (acme, .in, gmail)…" aria-label="Search domains" className="w-full rounded border bg-background px-2 py-1 text-sm sm:w-64" />
              <button type="button" onClick={() => setDomainTick(new Set(domainList.map((d) => d.domain)))} className="rounded border px-2 py-0.5 text-xs hover:bg-elevated">Select all {domainList.length.toLocaleString()} shown</button>
              <button type="button" onClick={() => setDomainTick(new Set())} className="rounded border px-2 py-0.5 text-xs hover:bg-elevated">Clear ticks</button>
              <span className="flex-1" />
              <button type="button" disabled={!domainTick.size} onClick={() => { applyDomains([...domainTick]); setDomainTick(new Set()); setDomainQ(''); setDomainPanel(false); }} data-domains-apply className="btn-primary !py-1 text-sm">Show only these{domainTick.size ? ` (${tickedCount.toLocaleString()})` : ''}</button>
              {canDelete && <button type="button" disabled={!domainTick.size || busy} onClick={deleteDomains} data-domains-delete className="inline-flex items-center gap-1 rounded border border-destructive/40 px-2.5 py-1 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /> Delete these{domainTick.size ? ` (${tickedCount.toLocaleString()})` : ''}</button>}
              <button type="button" onClick={() => setDomainPanel(false)} aria-label="Close domains" className="rounded border p-1 hover:bg-elevated"><X className="h-3.5 w-3.5" /></button>
            </div>
            <ul className="mt-2 grid max-h-48 grid-cols-1 gap-x-4 gap-y-0.5 overflow-auto text-sm sm:grid-cols-2 lg:grid-cols-3">
              {domainList.length === 0 && <li className="text-xs text-muted-foreground">{domainQ ? 'No domain matches.' : 'Loading…'}</li>}
              {domainList.map((d) => (
                <li key={d.domain}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-elevated">
                    <input type="checkbox" checked={domainTick.has(d.domain)} onChange={() => toggleDomain(d.domain)} aria-label={`Select ${d.domain}`} />
                    <span className="truncate">{d.domain}</span>
                    <span className="ml-auto tabular-nums text-xs text-muted-foreground">{d.count.toLocaleString()}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Add forms */}
        {canEdit && adding === 'one' && (
          <div className="border-b bg-muted/40 px-3 py-2" data-add-one>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs"><span className="mb-0.5 block font-medium">{emailHeader}</span>
                <input autoFocus type="email" value={addValues.__email ?? ''} onChange={(e) => setAddValues((v) => ({ ...v, __email: e.target.value }))} onKeyDown={onEnter(addOne)} placeholder="name@company.com" aria-label={`New ${emailHeader}`} className={input} />
              </label>
              {others.map((c) => (
                <label key={c} className="text-xs"><span className="mb-0.5 block font-medium">{c}</span>
                  <input value={addValues[c] ?? ''} onChange={(e) => setAddValues((v) => ({ ...v, [c]: e.target.value }))} onKeyDown={onEnter(addOne)} aria-label={`New ${c}`} className={input} />
                </label>
              ))}
              <button type="button" disabled={busy} onClick={addOne} className="btn-primary !py-1 text-sm">Add</button>
              <button type="button" onClick={() => setAdding(null)} className="rounded border px-2.5 py-1 text-sm hover:bg-elevated">Cancel</button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">The same inbox written another way (Gmail dots or +tags) counts as already in the list.</p>
          </div>
        )}
        {canEdit && adding === 'paste' && (
          <div className="border-b bg-muted/40 px-3 py-2" data-add-paste>
            <textarea autoFocus value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={4} placeholder={'One per line: asha@acme.com  or  Asha Rao <asha@acme.com>'} aria-label="Emails to add" className="w-full rounded border bg-background px-2 py-1 font-mono text-xs" />
            <div className="mt-1 flex items-center gap-2">
              <button type="button" disabled={busy || !pasteText.trim()} onClick={addPasted} className="btn-primary !py-1 text-sm">Add {parsePastedRecruiters(pasteText).length ? parsePastedRecruiters(pasteText).length.toLocaleString() : ''}</button>
              <button type="button" onClick={() => setAdding(null)} className="rounded border px-2.5 py-1 text-sm hover:bg-elevated">Cancel</button>
              <span className="text-xs text-muted-foreground">{columns.length ? 'Other columns are left empty; edit them after.' : 'A name before the address is kept.'}</span>
            </div>
          </div>
        )}

        {/* Selection bar */}
        {canDelete && selectedCount > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-3 py-1.5 text-sm" data-selection-bar role="status">
            <b>{selectedCount.toLocaleString()}</b> selected
            {!allMatching && data && data.total > rows.length && pageAllPicked && (
              <button type="button" onClick={() => setAllMatching(true)} className="text-primary hover:underline">Select all {data.total.toLocaleString()} {q ? 'matching' : 'in the list'}</button>
            )}
            <span className="flex-1" />
            {!allMatching && <button type="button" onClick={copyEmails} className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs hover:bg-elevated"><Copy className="h-3 w-3" /> Copy emails</button>}
            <button type="button" disabled={busy} onClick={deleteSelected} className="inline-flex items-center gap-1 rounded border border-destructive/40 px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10" data-delete-selected><Trash2 className="h-3 w-3" /> Delete</button>
            <button type="button" onClick={clearSelection} className="rounded border px-2 py-0.5 text-xs hover:bg-elevated">Clear</button>
          </div>
        )}

        <div ref={scrollRef} className="min-h-[12rem] flex-1 overflow-auto">
          {error ? (
            <p className="p-4 text-sm text-red-600">{error}</p>
          ) : !data ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : data.recipients.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{q || domainFilter.length ? 'No recruiter matches that search or filter.' : 'No recruiters in this send yet.'}</p>
          ) : (
            <table className={`w-full text-sm ${loading ? 'opacity-60' : ''}`} data-recruiter-table>
              <thead className="sticky top-0 z-10 bg-card text-left text-xs text-muted-foreground shadow-[0_1px_0_hsl(var(--border))]">
                <tr>
                  {canDelete && (
                    <th scope="col" className="w-8 px-2 py-1.5">
                      <input type="checkbox" checked={pageAllPicked || allMatching} onChange={togglePage} aria-label="Select all on this page" />
                    </th>
                  )}
                  <th scope="col" className="whitespace-nowrap px-2 py-1.5 font-medium" aria-sort={sort.key === 'order' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" onClick={() => sortBy('order')} className="inline-flex items-center gap-1" title="Back to the order of the sheet" data-sort="order">#<SortIcon k="order" /></button>
                  </th>
                  <th scope="col" className="whitespace-nowrap bg-primary/10 px-2 py-1.5 font-semibold text-foreground" aria-sort={sort.key === 'email' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" onClick={() => sortBy('email')} className="inline-flex items-center gap-1" data-sort="email" title="Sort by email">{emailHeader}<SortIcon k="email" /></button>
                  </th>
                  {others.map((c) => (
                    <th key={c} scope="col" className="whitespace-nowrap px-2 py-1.5 font-medium">
                      {!columns.length && c === 'Name' ? (
                        <button type="button" onClick={() => sortBy('name')} className="inline-flex items-center gap-1" data-sort="name">{c}<SortIcon k="name" /></button>
                      ) : c}
                    </th>
                  ))}
                  {showStatus && (
                    <th scope="col" className="whitespace-nowrap px-2 py-1.5 font-medium">
                      <button type="button" onClick={() => sortBy('status')} className="inline-flex items-center gap-1" data-sort="status">Status<SortIcon k="status" /></button>
                    </th>
                  )}
                  {(canEdit || canDelete) && <th scope="col" className="w-20 px-2 py-1.5 text-right font-medium"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {data.recipients.map((r, i) => {
                  const isEditing = editing?.id === r.id;
                  const isPicked = allMatching || picked.has(r.id);
                  return (
                    <tr key={r.id} data-row-id={r.id} className={`border-t border-border-subtle align-top hover:bg-elevated ${isPicked ? 'bg-primary/5' : ''}`}>
                      {canDelete && (
                        <td className="px-2 py-1"><input type="checkbox" checked={isPicked} disabled={allMatching} onChange={() => toggleRow(r)} aria-label={`Select ${r.email}`} /></td>
                      )}
                      <td className="whitespace-nowrap px-2 py-1 text-xs text-muted-foreground">{(from + i).toLocaleString()}</td>
                      {isEditing ? (
                        <>
                          <td className="bg-primary/5 px-2 py-1"><input autoFocus type="email" value={editing.values.__email ?? ''} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, __email: e.target.value } })} onKeyDown={onEnter(saveEdit)} aria-label={`Edit ${emailHeader}`} className={input} /></td>
                          {others.map((c) => (
                            <td key={c} className="px-2 py-1"><input value={editing.values[c] ?? ''} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, [c]: e.target.value } })} onKeyDown={onEnter(saveEdit)} aria-label={`Edit ${c}`} className={input} /></td>
                          ))}
                          {showStatus && <td />}
                          <td className="whitespace-nowrap px-2 py-1 text-right">
                            <button type="button" disabled={busy} onClick={saveEdit} aria-label="Save changes" title="Save (Enter)" className="mr-1 rounded border p-1 text-green-700 hover:bg-elevated"><Check className="h-3.5 w-3.5" /></button>
                            <button type="button" onClick={() => setEditing(null)} aria-label="Cancel editing" title="Cancel (Esc)" className="rounded border p-1 hover:bg-elevated"><X className="h-3.5 w-3.5" /></button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="whitespace-nowrap bg-primary/5 px-2 py-1 font-medium">{r.email}</td>
                          {others.map((c) => {
                            const v = cell(r, c);
                            return <td key={c} className={`px-2 py-1 align-top ${FIT_CELL[fit]}`} title={fit !== 'full' && v.length > 40 ? v : undefined}>{v || <span className="text-muted-foreground">—</span>}</td>;
                          })}
                          {showStatus && <td className={`whitespace-nowrap px-2 py-1 text-xs ${STATUS_TONE[r.status] ?? ''}`}>{STATUS_LABEL[r.status] ?? r.status.toLowerCase()}</td>}
                          {(canEdit || canDelete) && (
                            <td className="whitespace-nowrap px-2 py-1 text-right">
                              {canEdit && <button type="button" onClick={() => startEdit(r)} aria-label={`Edit ${r.email}`} title="Edit this row" data-edit className="mr-1 rounded border p-1 text-muted-foreground hover:bg-elevated hover:text-foreground"><Pencil className="h-3.5 w-3.5" /></button>}
                              {canDelete && <button type="button" disabled={busy} onClick={() => void deleteRows({ ids: [r.id] }, `${r.email} deleted`)} aria-label={`Delete ${r.email}`} title="Delete this row" data-delete className="rounded border p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>}
                            </td>
                          )}
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {undo && (
          <div className="flex items-center gap-2 border-t bg-foreground px-3 py-1.5 text-sm text-background" role="status" data-undo-bar>
            {undo.label}
            <button type="button" disabled={busy} onClick={undoDelete} className="inline-flex items-center gap-1 rounded border border-background/40 px-2 py-0.5 text-xs hover:bg-background/10"><Undo2 className="h-3 w-3" /> Undo</button>
            <span className="flex-1" />
            <button type="button" onClick={() => setUndo(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}
        {data && data.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
            <span className="text-xs text-muted-foreground">Showing {from.toLocaleString()}–{to.toLocaleString()} of {data.total.toLocaleString()}{!canEdit && !canDelete && data.status !== 'DRAFT' ? ' · the list is locked once a send has started' : ''}</span>
            <Pager page={data.page} pages={data.pages} onPage={setPage} label="Recruiter list pages" />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
