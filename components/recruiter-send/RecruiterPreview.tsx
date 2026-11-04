'use client';

import { useMemo, useState } from 'react';
import { EmailPreview } from '@/components/email-preview/EmailPreview';

/**
 * Recruiter Bulk Send previews: the live email preview beside the form (like Quick Send), and
 * after the check, who receives it — each recruiter's batch and the mailbox it goes from — next
 * to the email (like a campaign's review).
 */

type PreviewMode = 'desktop' | 'mobile';

function ModeToggle({ mode, onChange }: { mode: PreviewMode; onChange: (m: PreviewMode) => void }) {
  return (
    <div className="flex shrink-0 rounded-full border p-0.5 text-[11px]" role="group" aria-label="Preview size">
      {(['desktop', 'mobile'] as const).map((m) => (
        <button key={m} type="button" aria-pressed={mode === m} onClick={() => onChange(m)} className={`rounded-full px-2 py-0.5 ${mode === m ? 'bg-foreground text-background' : 'text-muted-foreground'}`}>
          {m === 'desktop' ? 'Desktop' : 'Phone'}
        </button>
      ))}
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

/** Sticky preview beside the form: the envelope (From / To / CC / Bcc / Reply-To) and the email itself. */
export function LivePreview({ html, envelope }: { html: string; envelope: EnvelopeInfo }) {
  const [mode, setMode] = useState<PreviewMode>('desktop');
  const e = envelope;
  const rows: [string, string][] = [
    ['From', e.fromEmail ? `${e.fromName ? `${e.fromName} ` : ''}<${e.fromEmail}>` : 'choose a mailbox under “Send from”'],
    ['To', e.mode === 'BCC' ? e.toAddress || '— add the visible “To” address' : 'each recruiter, one email each'],
    ...(e.ccAddresses.length ? [['CC', e.ccAddresses.join(', ')] as [string, string]] : []),
    ...(e.mode === 'BCC' ? [['Bcc', `up to ${e.perEmail} recruiters per email (hidden from each other)`] as [string, string]] : []),
    ...(e.replyTo ? [['Reply-To', e.replyTo] as [string, string]] : []),
  ];
  return (
    <div className="flex max-h-[calc(100vh-6rem)] flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex items-start justify-between gap-2 border-b px-3 py-2">
        <dl className="min-w-0 space-y-0.5 text-xs">
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
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {html ? <EmailPreview html={html} mode={mode} /> : <p className="p-6 text-center text-sm text-muted-foreground">Write the message to see the preview.</p>}
      </div>
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
    <div className="rounded-lg border bg-card p-4">
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

/** After the check: who receives it, in which batch, from which mailbox — beside the email. */
export function WhoReceives({ people, batches, total, html, subject, mode: sendMode }: { people: PlannedPerson[]; batches: PlannedBatch[]; total: number; html: string; subject: string; mode: 'BCC' | 'INDIVIDUAL' }) {
  const [mode, setMode] = useState<PreviewMode>('desktop');
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState<'all' | 'sending' | 'skipped'>('all');
  const rows = useMemo(() => people.filter((p) => (filter === 'all' ? true : filter === 'skipped' ? !!p.skipped : !p.skipped)), [people, filter]);
  const shown = showAll ? rows : rows.slice(0, 50);
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
    const m = new Map<number, { first: string; count: number }>();
    for (const p of people) {
      if (p.batch == null) continue;
      const v = m.get(p.batch);
      if (v) v.count += 1;
      else m.set(p.batch, { first: p.email, count: 1 });
    }
    return m;
  }, [people]);
  const [batchFilter, setBatchFilter] = useState<number | null>(null);
  const visibleRows = batchFilter == null ? shown : rows.filter((p) => p.batch === batchFilter);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      {byMailbox.length > 0 && (
        <div className="rounded-lg border bg-card p-3">
          <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Whose account sends it</div>
          <ul className="space-y-0.5 text-sm">
            {byMailbox.map(([mailbox, v]) => (
              <li key={mailbox} className="flex justify-between gap-2">
                <span className={`min-w-0 truncate ${mailbox.startsWith('Later') ? 'text-warning' : ''}`}>{mailbox}</span>
                <span className="shrink-0 text-muted-foreground">{v.emails.toLocaleString()} email{v.emails === 1 ? '' : 's'} · {v.recruiters.toLocaleString()} recruiters</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-muted-foreground">Planned from today&apos;s allowances; if a mailbox fills up or Gmail pauses it while sending, the next chosen one takes over.</p>
        </div>
      )}
        <div className="flex min-w-0 flex-col rounded-lg border bg-card">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-xs font-semibold uppercase text-muted-foreground">Batches ({batches.length.toLocaleString()} email{batches.length === 1 ? '' : 's'})</span>
            {batchFilter != null && <button type="button" onClick={() => setBatchFilter(null)} className="text-xs text-primary hover:underline">Show everyone</button>}
          </div>
          <div className="max-h-56 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-medium">{sendMode === 'BCC' ? 'Batch' : 'Email'}</th>
                  <th className="px-2 py-1.5 font-medium">Recruiters</th>
                  <th className="px-2 py-1.5 font-medium">Sends from</th>
                  <th className="px-2 py-1.5 font-medium">Starts with</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((bt) => (
                  <tr
                    key={bt.seq}
                    onClick={() => setBatchFilter(bt.seq)}
                    className={`cursor-pointer border-t border-border-subtle hover:bg-elevated ${batchFilter === bt.seq ? 'bg-elevated' : ''}`}
                    title="Show the recruiters in this batch"
                  >
                    <td className="px-3 py-1.5 font-medium">#{bt.seq}</td>
                    <td className="px-2 py-1.5">{bt.size.toLocaleString()}</td>
                    <td className="max-w-[14rem] truncate px-2 py-1.5" title={bt.mailbox ?? ''}>{bt.mailbox ?? <span className="text-warning">later — allowance used up</span>}</td>
                    <td className="max-w-[12rem] truncate px-2 py-1.5 text-muted-foreground">{firstIn.get(bt.seq)?.first ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">Click a batch to list its recruiters below.</p>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col rounded-lg border bg-card">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-xs font-semibold uppercase text-muted-foreground">Who receives this{batchFilter != null ? ` — batch #${batchFilter}` : ''}</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="rounded border bg-background px-1 py-0.5 text-xs" aria-label="Show">
              <option value="all">Everyone ({people.length.toLocaleString()})</option>
              <option value="sending">Will get it</option>
              <option value="skipped">Skipped</option>
            </select>
          </div>
          <div className="max-h-[480px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Email</th>
                  <th className="px-2 py-1.5 font-medium">Name</th>
                  <th className="px-2 py-1.5 font-medium">{sendMode === 'BCC' ? 'Batch' : 'Email #'}</th>
                  <th className="px-2 py-1.5 font-medium">Sends from</th>
                  <th className="px-2 py-1.5 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((p) => (
                  <tr key={p.email} className={`border-t border-border-subtle ${p.skipped ? 'bg-red-50 dark:bg-red-950/30' : ''}`}>
                    <td className="max-w-[14rem] truncate px-3 py-1.5" title={p.email}>{p.email}</td>
                    <td className="max-w-[8rem] truncate px-2 py-1.5">{p.name ?? ''}</td>
                    <td className="px-2 py-1.5">{p.batch ?? '—'}</td>
                    <td className="max-w-[12rem] truncate px-2 py-1.5" title={p.mailbox ?? ''}>{p.skipped ? '—' : p.mailbox ?? <span className="text-warning">later</span>}</td>
                    <td className={`px-2 py-1.5 ${p.skipped ? 'text-red-700 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}>{p.skipped ?? 'Will get it'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {batchFilter == null && rows.length > 50 && (
            <button type="button" onClick={() => setShowAll((s) => !s)} className="border-t px-3 py-2 text-xs text-primary hover:bg-elevated">
              {showAll ? 'Show fewer' : `Show all ${rows.length.toLocaleString()}`}
            </button>
          )}
          {total > people.length && <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">Listing the first {people.length.toLocaleString()} of {total.toLocaleString()}.</p>}
        </div>

        <div className="flex min-w-0 flex-col rounded-lg border bg-card">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <div className="min-w-0 truncate text-xs"><span className="text-muted-foreground">Subject: </span><span className="font-medium">{subject || '—'}</span></div>
            <ModeToggle mode={mode} onChange={setMode} />
          </div>
          <div className="min-h-[300px] flex-1 overflow-auto">
            <EmailPreview html={html} mode={mode} />
          </div>
          <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">Every recruiter gets this same email{sendMode === 'BCC' ? ', with their address hidden in Bcc' : ''}.</p>
        </div>
      </div>
    </div>
  );
}
