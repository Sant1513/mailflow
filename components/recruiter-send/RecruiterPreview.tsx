'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { EmailPreview } from '@/components/email-preview/EmailPreview';

/**
 * Recruiter Bulk Send previews: the live email preview beside the form (like Quick Send), and
 * after the check, who receives it — each recruiter's batch and the mailbox it goes from — next
 * to the email (like a campaign's review).
 */

type PreviewMode = 'desktop' | 'mobile';
const PRESET_WIDTH: Record<PreviewMode, number> = { desktop: 700, mobile: 375 };

/** Page through a list: « ‹ page x of y › ». Hidden when everything fits on one page. */
export function Pager({ page, pages, onPage, label }: { page: number; pages: number; onPage: (p: number) => void; label?: string }) {
  if (pages <= 1) return null;
  const btn = 'rounded border px-2 py-0.5 hover:bg-elevated disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <nav className="flex flex-wrap items-center justify-center gap-1.5 text-xs" aria-label={label ?? 'Pages'}>
      <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(1)} aria-label="First page">«</button>
      <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">‹ Prev</button>
      <span className="px-1 text-muted-foreground">Page {page} of {pages}</span>
      <button type="button" className={btn} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">Next ›</button>
      <button type="button" className={btn} disabled={page >= pages} onClick={() => onPage(pages)} aria-label="Last page">»</button>
    </nav>
  );
}

/**
 * The email in a frame you can size: Desktop / Phone presets, a width slider, and a drag handle
 * (bottom edge) for the height. Remembers the size per viewer (this browser only).
 */
export function EmailViewer({ html, storageKey, defaultHeight = 520, header, empty }: { html: string; storageKey: string; defaultHeight?: number; header?: React.ReactNode; empty?: string }) {
  const [mode, setMode] = useState<PreviewMode>('desktop');
  const [width, setWidth] = useState<number>(PRESET_WIDTH.desktop);
  const [height, setHeight] = useState<number>(defaultHeight);
  const frame = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`email-viewer:${storageKey}`) ?? 'null') as { width?: number; height?: number; mode?: PreviewMode } | null;
      if (saved?.mode) setMode(saved.mode);
      if (saved?.width) setWidth(saved.width);
      if (saved?.height) setHeight(saved.height);
    } catch {
      /* private window or blocked storage: defaults are fine */
    }
  }, [storageKey]);
  useEffect(() => {
    try {
      localStorage.setItem(`email-viewer:${storageKey}`, JSON.stringify({ width, height, mode }));
    } catch {
      /* ignore */
    }
  }, [storageKey, width, height, mode]);

  // The frame's bottom edge can be dragged (CSS resize); follow it.
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const h = Math.round(el.clientHeight);
      if (h > 0) setHeight((prev) => (Math.abs(prev - h) > 2 ? h : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pick = (m: PreviewMode) => {
    setMode(m);
    setWidth(PRESET_WIDTH[m]);
  };

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">{header}</div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex shrink-0 rounded-full border p-0.5 text-[11px]" role="group" aria-label="Preview size">
            {(['desktop', 'mobile'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m && width === PRESET_WIDTH[m]} onClick={() => pick(m)} className={`rounded-full px-2 py-0.5 ${mode === m && width === PRESET_WIDTH[m] ? 'bg-foreground text-background' : 'text-muted-foreground'}`}>
                {m === 'desktop' ? 'Desktop' : 'Phone'}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            Width
            <input type="range" min={320} max={1000} step={10} value={width} onChange={(e) => setWidth(Number(e.target.value))} className="w-20 sm:w-24" aria-label="Preview width" />
            <span className="w-10 tabular-nums">{width}px</span>
          </label>
          <button type="button" onClick={() => { pick('desktop'); setHeight(defaultHeight); }} className="text-[11px] text-primary hover:underline">Reset</button>
        </div>
      </div>
      <div ref={frame} className="overflow-auto" style={{ height, minHeight: 260, maxHeight: 1600, resize: 'vertical' }} title="Drag the bottom edge to make the preview taller or shorter">
        {html ? <EmailPreview html={html} mode={mode} width={width} height={Math.max(220, height - 40)} /> : <p className="p-6 text-center text-sm text-muted-foreground">{empty ?? 'Nothing to preview yet.'}</p>}
      </div>
      <div className="border-t px-3 py-1 text-center text-[10px] text-muted-foreground">⇕ drag the edge above to resize</div>
    </div>
  );
}

export interface EnvelopeInfo {
  mode: 'BCC' | 'INDIVIDUAL';
  fromName: string | null;
  fromEmail: string | null;
  toAddress: string | null;
  ccAddresses: string[];
  replyTo: string | null;
  subject: string;
  perEmail: number;
  attachments: string[];
}

/** Preview beside the form: the envelope (From / To / CC / Bcc / Reply-To) and the email itself. */
export function LivePreview({ html, envelope }: { html: string; envelope: EnvelopeInfo }) {
  const e = envelope;
  const rows: [string, string][] = [
    ['From', e.fromEmail ? `${e.fromName ? `${e.fromName} ` : ''}<${e.fromEmail}>` : 'choose a mailbox under “Send from”'],
    ['To', e.mode === 'BCC' ? e.toAddress || '— add the visible “To” address' : 'each recruiter, one email each'],
    ...(e.ccAddresses.length ? [['CC', e.ccAddresses.join(', ')] as [string, string]] : []),
    ...(e.mode === 'BCC' ? [['Bcc', `up to ${e.perEmail} recruiters per email (hidden from each other)`] as [string, string]] : []),
    ...(e.replyTo ? [['Reply-To', e.replyTo] as [string, string]] : []),
  ];
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <dl className="space-y-0.5 border-b px-3 py-2 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-1">
            <dt className="w-14 shrink-0 text-muted-foreground">{k}:</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
        <div className="flex gap-1 pt-0.5">
          <dt className="w-14 shrink-0 text-muted-foreground">Subject:</dt>
          <dd className="min-w-0 break-words font-semibold">{e.subject || <span className="font-normal text-muted-foreground">— no subject yet</span>}</dd>
        </div>
      </dl>
      <EmailViewer html={html} storageKey="recruiter-live" defaultHeight={480} empty="Write the message to see the preview." />
      {e.attachments.length > 0 && (
        <div className="border-t px-3 py-2 text-xs">
          {e.attachments.map((a) => <div key={a} className="truncate">📎 {a}</div>)}
        </div>
      )}
    </div>
  );
}

/** "Review before sending": every setting of the send at a glance, like a campaign's review. */
export function SendSummary({ items, warnings }: { items: [string, string][]; warnings: string[] }) {
  return (
    <div className="rounded-lg border bg-card p-3 sm:p-4">
      <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Review before sending</div>
      <dl className="grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
        {items.map(([k, v]) => (
          <div key={k} className="flex min-w-0 gap-1.5">
            <dt className="shrink-0 text-muted-foreground">{k}:</dt>
            <dd className="min-w-0 break-words font-medium">{v || '—'}</dd>
          </div>
        ))}
      </dl>
      {warnings.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-warning">
          {warnings.map((w) => <li key={w}>⚠ {w}</li>)}
        </ul>
      )}
    </div>
  );
}

export interface PlannedPerson { email: string; name: string | null; batch: number | null; mailbox: string | null; skipped: string | null }
export interface PlannedBatch { seq: number; size: number; mailbox: string | null }

const PEOPLE_PER_PAGE = 50;
const BATCHES_PER_PAGE = 20;

/** After the check: who receives it, in which batch, from which mailbox — beside the email. */
export function WhoReceives({ people, batches, total, html, subject, mode: sendMode }: { people: PlannedPerson[]; batches: PlannedBatch[]; total: number; html: string; subject: string; mode: 'BCC' | 'INDIVIDUAL' }) {
  const [filter, setFilter] = useState<'all' | 'sending' | 'skipped'>('all');
  const [batchFilter, setBatchFilter] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [batchPage, setBatchPage] = useState(1);

  const rows = useMemo(
    () => people.filter((p) => (filter === 'all' ? true : filter === 'skipped' ? !!p.skipped : !p.skipped)).filter((p) => batchFilter == null || p.batch === batchFilter),
    [people, filter, batchFilter],
  );
  const pages = Math.max(1, Math.ceil(rows.length / PEOPLE_PER_PAGE));
  const batchPages = Math.max(1, Math.ceil(batches.length / BATCHES_PER_PAGE));
  // A new plan or filter starts again at page 1 (and never points past the end).
  useEffect(() => setPage(1), [filter, batchFilter, people]);
  useEffect(() => setBatchPage((p) => Math.min(p, batchPages)), [batchPages]);
  const shownRows = rows.slice((page - 1) * PEOPLE_PER_PAGE, page * PEOPLE_PER_PAGE);
  const shownBatches = batches.slice((batchPage - 1) * BATCHES_PER_PAGE, batchPage * BATCHES_PER_PAGE);

  const byMailbox = useMemo(() => {
    const m = new Map<string, { emails: number; recruiters: number }>();
    for (const b of batches) {
      const k = b.mailbox ?? 'Later (daily allowance used up)';
      const v = m.get(k) ?? { emails: 0, recruiters: 0 };
      v.emails += 1;
      v.recruiters += b.size;
      m.set(k, v);
    }
    return [...m.entries()];
  }, [batches]);
  const firstIn = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of people) if (p.batch != null && !m.has(p.batch)) m.set(p.batch, p.email);
    return m;
  }, [people]);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {byMailbox.length > 0 && (
          <div className="rounded-lg border bg-card p-3">
            <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Whose account sends it</div>
            <ul className="space-y-1 text-sm">
              {byMailbox.map(([mailbox, v]) => (
                <li key={mailbox} className="flex flex-wrap justify-between gap-x-2">
                  <span className={`min-w-0 break-all ${mailbox.startsWith('Later') ? 'text-warning' : ''}`}>{mailbox}</span>
                  <span className="shrink-0 text-muted-foreground">{v.emails.toLocaleString()} email{v.emails === 1 ? '' : 's'} · {v.recruiters.toLocaleString()} recruiters</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-muted-foreground">Planned from today&apos;s allowances; if a mailbox fills up or Gmail pauses it while sending, the next chosen one takes over.</p>
          </div>
        )}

        <div className="flex min-w-0 flex-col rounded-lg border bg-card">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-xs font-semibold uppercase text-muted-foreground">Batches ({batches.length.toLocaleString()} email{batches.length === 1 ? '' : 's'})</span>
            {batchFilter != null && <button type="button" onClick={() => setBatchFilter(null)} className="text-xs text-primary hover:underline">Show everyone</button>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-xs">
              <thead className="bg-card text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-medium">{sendMode === 'BCC' ? 'Batch' : 'Email'}</th>
                  <th className="px-2 py-1.5 font-medium">Recruiters</th>
                  <th className="px-2 py-1.5 font-medium">Sends from</th>
                  <th className="px-2 py-1.5 font-medium">Starts with</th>
                </tr>
              </thead>
              <tbody>
                {shownBatches.map((bt) => (
                  <tr
                    key={bt.seq}
                    onClick={() => setBatchFilter(bt.seq)}
                    className={`cursor-pointer border-t border-border-subtle hover:bg-elevated ${batchFilter === bt.seq ? 'bg-elevated' : ''}`}
                    title="Show the recruiters in this batch"
                  >
                    <td className="px-3 py-1.5 font-medium">#{bt.seq}</td>
                    <td className="px-2 py-1.5">{bt.size.toLocaleString()}</td>
                    <td className="max-w-[14rem] truncate px-2 py-1.5" title={bt.mailbox ?? ''}>{bt.mailbox ?? <span className="text-warning">later — allowance used up</span>}</td>
                    <td className="max-w-[12rem] truncate px-2 py-1.5 text-muted-foreground">{firstIn.get(bt.seq) ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-1 border-t px-3 py-1.5">
            <Pager page={batchPage} pages={batchPages} onPage={setBatchPage} label="Batch pages" />
            <p className="text-center text-[11px] text-muted-foreground">Click a batch to list its recruiters below.</p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col rounded-lg border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-xs font-semibold uppercase text-muted-foreground">
              Who receives this{batchFilter != null ? ` — batch #${batchFilter}` : ''} <span className="font-normal normal-case">({rows.length.toLocaleString()})</span>
            </span>
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="rounded border bg-background px-1 py-0.5 text-xs" aria-label="Show">
              <option value="all">Everyone</option>
              <option value="sending">Will get it</option>
              <option value="skipped">Skipped</option>
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-xs">
              <thead className="bg-card text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Email</th>
                  <th className="px-2 py-1.5 font-medium">Name</th>
                  <th className="px-2 py-1.5 font-medium">{sendMode === 'BCC' ? 'Batch' : 'Email #'}</th>
                  <th className="px-2 py-1.5 font-medium">Sends from</th>
                  <th className="px-2 py-1.5 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {shownRows.map((p) => (
                  <tr key={p.email} className={`border-t border-border-subtle ${p.skipped ? 'bg-red-50 dark:bg-red-950/30' : ''}`}>
                    <td className="max-w-[14rem] truncate px-3 py-1.5" title={p.email}>{p.email}</td>
                    <td className="max-w-[8rem] truncate px-2 py-1.5">{p.name ?? ''}</td>
                    <td className="px-2 py-1.5">{p.batch ?? '—'}</td>
                    <td className="max-w-[12rem] truncate px-2 py-1.5" title={p.mailbox ?? ''}>{p.skipped ? '—' : p.mailbox ?? <span className="text-warning">later</span>}</td>
                    <td className={`px-2 py-1.5 ${p.skipped ? 'text-red-700 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}>{p.skipped ?? 'Will get it'}</td>
                  </tr>
                ))}
                {!shownRows.length && (
                  <tr><td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">Nobody here.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="space-y-1 border-t px-3 py-1.5">
            <Pager page={page} pages={pages} onPage={setPage} label="Recruiter pages" />
            {total > people.length && <p className="text-center text-[11px] text-muted-foreground">The plan lists the first {people.length.toLocaleString()} of {total.toLocaleString()} recruiters; all of them are sent.</p>}
          </div>
        </div>

        <div className="min-w-0 overflow-hidden rounded-lg border bg-card">
          <EmailViewer
            html={html}
            storageKey="recruiter-review"
            header={<div className="min-w-0 truncate text-xs"><span className="text-muted-foreground">Subject: </span><span className="font-medium">{subject || '—'}</span></div>}
          />
          <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">Every recruiter gets this same email{sendMode === 'BCC' ? ', with their address hidden in Bcc' : ''}.</p>
        </div>
      </div>
    </div>
  );
}
