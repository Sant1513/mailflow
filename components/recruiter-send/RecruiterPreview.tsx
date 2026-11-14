'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { EmailViewer } from '@/components/recruiter-send/EmailViewer';
import { Avatar } from '@/components/ui/Avatar';
import { RecipientPanel, type PanelEnvelope } from '@/components/recruiter-send/RecipientPanel';

export { EmailViewer };

/**
 * Recruiter Bulk Send previews: the live email preview beside the form (like Quick Send), and
 * after the check, who receives it — each recruiter's batch and the mailbox it goes from — next
 * to the email (like a campaign's review).
 */

/**
 * Page through a list: « ‹ page x of y › », and with `jump` a "Go to page" box. Hidden when
 * everything fits on one page.
 */
export function Pager({ page, pages, onPage, label, jump = false }: { page: number; pages: number; onPage: (p: number) => void; label?: string; jump?: boolean }) {
  if (pages <= 1) return null;
  const btn = 'rounded border px-2 py-0.5 hover:bg-elevated disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <nav className="flex flex-wrap items-center justify-center gap-1.5 text-xs" aria-label={label ?? 'Pages'}>
      <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(1)} aria-label="First page">«</button>
      <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">‹ Prev</button>
      <span className="px-1 text-muted-foreground">Page {page} of {pages}</span>
      <button type="button" className={btn} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">Next ›</button>
      <button type="button" className={btn} disabled={page >= pages} onClick={() => onPage(pages)} aria-label="Last page">»</button>
      {jump && (
        <form
          className="flex items-center gap-1"
          onSubmit={(ev) => {
            ev.preventDefault();
            const input = ev.currentTarget.elements.namedItem('page') as HTMLInputElement | null;
            const n = Math.floor(Number(input?.value));
            if (Number.isFinite(n) && n >= 1) onPage(Math.min(pages, n));
            if (input) input.value = '';
          }}
        >
          <label className="text-muted-foreground">
            Go to <input name="page" type="number" min={1} max={pages} inputMode="numeric" placeholder={String(page)} aria-label="Page number" className="w-14 rounded border bg-background px-1 py-0.5" />
          </label>
          <button type="submit" className={btn}>Go</button>
        </form>
      )}
    </nav>
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
  /** Individual copies: the recruiter whose {{Column}} values fill this preview. */
  previewAs?: string | null;
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
    ...(e.replyTo ? [['Reply-To', `${e.replyTo}, ${e.fromEmail ?? 'the sending mailbox'}`] as [string, string]] : []),
  ];
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
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
      {e.previewAs && <div className="border-b bg-primary/5 px-3 py-1.5 text-[11px] text-muted-foreground">Shown with <b className="text-foreground">{e.previewAs}</b>&rsquo;s values; every recruiter gets their own.</div>}
      <EmailViewer fill html={html} storageKey="recruiter-live" defaultHeight={480} empty="Write the message to see the preview." />
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

export interface PlannedPerson { email: string; name: string | null; batch: number | null; batchSize?: number | null; round?: number | null; mailbox: string | null; skipped: string | null }
export interface PlannedBatch { seq: number; size: number; mailbox: string | null; round?: number | null }

/**
 * One page of the check's tables, as the server returns it (POST …/check and …/check/people):
 * the recruiter page (after filter / batch / search) and the batch page.
 */
export interface PlanPage {
  people: PlannedPerson[]; peopleTotal: number; peoplePage: number; peoplePages: number; peoplePageSize?: number;
  batches: PlannedBatch[]; batchesTotal: number; batchPage: number; batchPages: number;
  /** First recruiter of each batch on this batch page (seq → email). */
  batchFirst?: Record<string, string>;
}
/** Per sending mailbox over every batch (mailbox null = later, no room today). */
export interface MailboxShare { mailbox: string | null; emails: number; recruiters: number }

type PeopleFilter = 'all' | 'sending' | 'skipped';
interface TableQuery { peoplePage: number; peopleFilter: PeopleFilter; batch: number | null; q: string; batchPage: number }
const FIRST_QUERY: TableQuery = { peoplePage: 1, peopleFilter: 'all', batch: null, q: '', batchPage: 1 };
const DEFAULT_PAGE_SIZE = 50;

/**
 * After the check: who receives it, in which batch, from which mailbox — beside the email.
 * The tables show one page at a time; other pages, filters, a batch's recruiters and searches
 * are fetched from the server (only the visible page is ever in the browser).
 */
export function WhoReceives({
  plan, byMailbox, total, html, subject, mode: sendMode, blastId, version, envelope, parallel = false,
}: {
  /** The first page (from the check); a new check resets or refreshes the table. */
  plan: PlanPage; byMailbox: MailboxShare[]; total: number; html: string; subject: string; mode: 'BCC' | 'INDIVIDUAL';
  /** With blastId the table fetches its pages; with envelope too, clicking a recruiter shows their own email. */
  blastId?: string; version?: string; envelope?: Omit<PanelEnvelope, 'batch' | 'round' | 'mailbox' | 'batchSize' | 'skipped'>;
  /** All mailboxes send together, in rounds. */
  parallel?: boolean;
}) {
  const [data, setData] = useState<PlanPage>(plan);
  const [query, setQuery] = useState<TableQuery>(FIRST_QUERY);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The open recruiter and their position in the filtered list (across pages). */
  const [selected, setSelected] = useState<{ person: PlannedPerson; index: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;

  const size = data.peoplePageSize ?? DEFAULT_PAGE_SIZE;
  const offset = (data.peoplePage - 1) * size;

  /**
   * Fetch a page. The previous request is cancelled; the current rows stay until the new ones
   * arrive. selectAt picks a row of the new page (stepping across pages); keepSelection says
   * the list is the same (only the page moved), so the open recruiter stays open.
   */
  async function load(next: TableQuery, opts: { selectAt?: number; keepSelection?: boolean } = {}) {
    setQuery(next);
    if (!blastId) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    try {
      const res = await fetch(`/api/recruiter-blasts/${blastId}/check/people`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ peoplePage: next.peoplePage, peopleFilter: next.peopleFilter, batch: next.batch, q: next.q || undefined, batchPage: next.batchPage }),
        signal: ac.signal,
      });
      const j = await res.json().catch(() => ({}));
      if (ac.signal.aborted) return;
      if (!res.ok) { setError(j?.error ?? 'Could not load this page.'); return; }
      const page = j as PlanPage;
      setError(null);
      setData(page);
      // The server keeps pages in range; follow it.
      setQuery((q) => ({ ...q, peoplePage: page.peoplePage, batchPage: page.batchPage }));
      const pageOffset = (page.peoplePage - 1) * (page.peoplePageSize ?? DEFAULT_PAGE_SIZE);
      if (opts.selectAt !== undefined) {
        const k = Math.min(page.people.length - 1, Math.max(0, opts.selectAt));
        const p = page.people[k];
        if (p) setSelected({ person: p, index: pageOffset + k });
      } else {
        setSelected((s) => {
          if (!s) return s;
          const k = page.people.findIndex((p) => p.email === s.person.email);
          if (k >= 0) return { person: page.people[k]!, index: pageOffset + k };
          return opts.keepSelection ? s : null;
        });
      }
    } catch {
      if (!ac.signal.aborted) setError('Could not load this page.');
    } finally {
      if (abortRef.current === ac) { setLoading(false); abortRef.current = null; }
    }
  }

  // A new check: show its first page, or refresh the page being looked at.
  const firstPlan = useRef(true);
  useEffect(() => {
    if (firstPlan.current) { firstPlan.current = false; return; }
    const q = queryRef.current;
    if (q.peoplePage === 1 && q.batchPage === 1 && q.peopleFilter === 'all' && q.batch == null && !q.q) {
      abortRef.current?.abort();
      setLoading(false);
      setData(plan);
      setSelected((s) => {
        if (!s) return s;
        const k = plan.people.findIndex((p) => p.email === s.person.email);
        return k >= 0 ? { person: plan.people[k]!, index: k } : s;
      });
    } else void load(q, { keepSelection: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  // Search: wait for a pause in typing.
  useEffect(() => {
    const q = search.trim();
    if (q === queryRef.current.q) return;
    const t = setTimeout(() => void load({ ...queryRef.current, q, peoplePage: 1 }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const setPeoplePage = (p: number) => void load({ ...query, peoplePage: p }, { keepSelection: true });
  const setBatchPage = (p: number) => void load({ ...query, batchPage: p }, { keepSelection: true });
  const setFilter = (f: PeopleFilter) => void load({ ...query, peopleFilter: f, peoplePage: 1 });
  const setBatchFilter = (b: number | null) => void load({ ...query, batch: b, peoplePage: 1 });

  const shownRows = data.people;
  const person = selected?.person ?? null;
  const sizeOf = useMemo(() => new Map(data.batches.map((b) => [b.seq, b.size])), [data.batches]);
  // Step through recruiters (‹ › or ↑ ↓), loading the next / previous page when needed.
  const step = (delta: number) => {
    if (!selected) {
      const p = shownRows[delta < 0 ? shownRows.length - 1 : 0];
      if (p) setSelected({ person: p, index: offset + (delta < 0 ? shownRows.length - 1 : 0) });
      return;
    }
    const i = selected.index + delta;
    if (i < 0 || i >= data.peopleTotal) return;
    const page = Math.floor(i / size) + 1;
    if (page === data.peoplePage) {
      const p = shownRows[i - offset];
      if (p) setSelected({ person: p, index: i });
      return;
    }
    void load({ ...query, peoplePage: page }, { selectAt: i - (page - 1) * size });
  };
  const canPreview = !!(blastId && envelope);
  const shownBatches = data.batches;
  const firstIn = data.batchFirst ?? {};
  const later = 'Later (daily allowance used up)';

  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {byMailbox.length > 0 && (
          <div className="rounded-lg border bg-card p-3">
            <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Whose account sends it</div>
            <ul className="space-y-1 text-sm">
              {byMailbox.map((v) => (
                <li key={v.mailbox ?? later} className="flex flex-wrap justify-between gap-x-2">
                  <span className={`min-w-0 break-all ${v.mailbox == null ? 'text-warning' : ''}`}>{v.mailbox ?? later}</span>
                  <span className="shrink-0 text-muted-foreground">{v.emails.toLocaleString()} email{v.emails === 1 ? '' : 's'} · {v.recruiters.toLocaleString()} recruiters</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-muted-foreground">{parallel ? 'All of these send together: round 1 from every mailbox, then each waits its own pause before its next email. If a mailbox fills up, disconnects or Gmail pauses it, its batches move to the others.' : 'One after another: the first mailbox until its limit, then the next. If a mailbox fills up or Gmail pauses it while sending, the next chosen one takes over.'}</p>
          </div>
        )}

        <div className="flex min-w-0 flex-col rounded-lg border bg-card">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-xs font-semibold uppercase text-muted-foreground">Batches ({data.batchesTotal.toLocaleString()} email{data.batchesTotal === 1 ? '' : 's'})</span>
            {query.batch != null && <button type="button" onClick={() => setBatchFilter(null)} className="text-xs text-primary hover:underline">Show everyone</button>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-xs">
              <thead className="bg-card text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-medium">{sendMode === 'BCC' ? 'Batch' : 'Email'}</th>
                  {parallel && <th className="px-2 py-1.5 font-medium">Round</th>}
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
                    className={`cursor-pointer border-t border-border-subtle hover:bg-elevated ${query.batch === bt.seq ? 'bg-elevated' : ''}`}
                    title="Show the recruiters in this batch"
                  >
                    <td className="px-3 py-1.5 font-medium">#{bt.seq}</td>
                    {parallel && <td className="px-2 py-1.5 text-muted-foreground">{bt.round ?? '—'}</td>}
                    <td className="px-2 py-1.5">{bt.size.toLocaleString()}</td>
                    <td className="max-w-[14rem] truncate px-2 py-1.5" title={bt.mailbox ?? ''}>{bt.mailbox ?? <span className="text-warning">later — allowance used up</span>}</td>
                    <td className="max-w-[12rem] truncate px-2 py-1.5 text-muted-foreground" title={firstIn[bt.seq] ?? ''}>{firstIn[bt.seq] ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-1 border-t px-3 py-1.5">
            <Pager page={data.batchPage} pages={data.batchPages} onPage={setBatchPage} label="Batch pages" jump={data.batchPages > 5} />
            <p className="text-center text-[11px] text-muted-foreground">Click a batch to list its recruiters below.</p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col rounded-lg border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-xs font-semibold uppercase text-muted-foreground">
              Who receives this{query.batch != null ? ` — batch #${query.batch}` : ''} <span className="font-normal normal-case">({data.peopleTotal.toLocaleString()}{data.peopleTotal !== total ? ` of ${total.toLocaleString()}` : ''})</span>
              {loading && <span className="ml-2 font-normal normal-case text-muted-foreground" role="status">Loading…</span>}
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              {blastId && (
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search email or name"
                  aria-label="Search recruiters"
                  maxLength={200}
                  className="w-44 rounded border bg-background px-1.5 py-0.5 text-xs"
                />
              )}
              <select value={query.peopleFilter} onChange={(e) => setFilter(e.target.value as PeopleFilter)} className="rounded border bg-background px-1 py-0.5 text-xs" aria-label="Show">
                <option value="all">Everyone</option>
                <option value="sending">Will get it</option>
                <option value="skipped">Skipped</option>
              </select>
            </span>
          </div>
          {error && <p className="border-b bg-red-50 px-3 py-1 text-[11px] text-red-700 dark:bg-red-950/30 dark:text-red-400">{error}</p>}
          <div
            className={`overflow-x-auto outline-none transition-opacity ${loading ? 'opacity-60' : ''}`}
            aria-busy={loading || undefined}
            tabIndex={canPreview ? 0 : undefined}
            onKeyDown={(ev) => {
              if (!canPreview) return;
              if (ev.key === 'ArrowDown') { ev.preventDefault(); step(1); }
              if (ev.key === 'ArrowUp') { ev.preventDefault(); step(-1); }
            }}
          >
            <table className="w-full min-w-[560px] text-xs">
              <thead className="bg-card text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Email</th>
                  <th className="px-2 py-1.5 font-medium">Name</th>
                  <th className="px-2 py-1.5 font-medium">{sendMode === 'BCC' ? 'Batch' : 'Email #'}</th>
                  {parallel && <th className="px-2 py-1.5 font-medium">Round</th>}
                  <th className="px-2 py-1.5 font-medium">Sends from</th>
                  <th className="px-2 py-1.5 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {shownRows.map((p, k) => (
                  <tr
                    key={p.email}
                    onClick={canPreview ? () => setSelected({ person: p, index: offset + k }) : undefined}
                    aria-selected={person?.email === p.email}
                    title={canPreview ? 'Show the email this recruiter gets' : undefined}
                    className={`border-t border-border-subtle ${canPreview ? 'cursor-pointer hover:bg-elevated' : ''} ${person?.email === p.email ? 'bg-primary/10 ring-1 ring-inset ring-primary/40' : p.skipped ? 'bg-red-50 dark:bg-red-950/30' : ''}`}
                  >
                    <td className="max-w-[16rem] px-3 py-1.5" title={p.email}><span className="flex min-w-0 items-center gap-2"><Avatar email={p.email} name={p.name} size={22} /><span className="truncate">{p.email}</span></span></td>
                    <td className="max-w-[8rem] truncate px-2 py-1.5">{p.name ?? ''}</td>
                    <td className="px-2 py-1.5">{p.batch ?? '—'}</td>
                    {parallel && <td className="px-2 py-1.5 text-muted-foreground">{p.round ?? '—'}</td>}
                    <td className="max-w-[12rem] truncate px-2 py-1.5" title={p.mailbox ?? ''}>{p.skipped ? '—' : p.mailbox ?? <span className="text-warning">later</span>}</td>
                    <td title={p.skipped ?? undefined} className={`max-w-[14rem] truncate px-2 py-1.5 ${p.skipped ? 'text-red-700 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}>{p.skipped ? `Skipped: ${p.skipped}` : 'Will get it'}</td>
                  </tr>
                ))}
                {!shownRows.length && (
                  <tr><td colSpan={parallel ? 6 : 5} className="px-3 py-4 text-center text-muted-foreground">Nobody here.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="space-y-1 border-t px-3 py-1.5">
            <Pager page={data.peoplePage} pages={data.peoplePages} onPage={setPeoplePage} label="Recruiter pages" jump />
          </div>
        </div>

        {canPreview && person ? (
          <RecipientPanel
            blastId={blastId!}
            email={person.email}
            version={version ?? ''}
            envelope={{ ...envelope!, batch: person.batch, round: person.round ?? null, mailbox: person.mailbox, batchSize: person.batchSize ?? (person.batch != null ? sizeOf.get(person.batch) ?? null : null), skipped: person.skipped }}
            position={{ index: selected!.index, total: data.peopleTotal }}
            onStep={step}
            onClose={() => setSelected(null)}
          />
        ) : (
        <div className="flex min-h-[480px] min-w-0 flex-col overflow-hidden rounded-lg border bg-card">
          {canPreview && <p className="border-b bg-primary/5 px-3 py-1.5 text-[11px] text-muted-foreground">Click any recruiter to see the email <b className="text-foreground">they</b> get: their values, batch and mailbox.</p>}
          <EmailViewer
            fill
            html={html}
            storageKey="recruiter-review"
            header={<div className="min-w-0 truncate text-xs"><span className="text-muted-foreground">Subject: </span><span className="font-medium">{subject || '—'}</span></div>}
          />
          <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">{canPreview ? 'The email as written.' : `Every recruiter gets this same email${sendMode === 'BCC' ? ', with their address hidden in Bcc' : ''}.`}</p>
        </div>
        )}
      </div>
    </div>
  );
}
