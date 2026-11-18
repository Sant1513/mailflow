'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { STATUS_STYLE } from '@/lib/recruiterSend/ui';

/** Pieces of a follow-up's page: the earlier email, who gets it, and what to do if its mailbox is down. */

const FIELD = 'w-full rounded border bg-background px-2 py-1.5 text-sm';

export interface FollowUpChainItem { id: string; name: string; round: number; status: string; current: boolean }
export interface FollowUpContext {
  chain: FollowUpChainItem[];
  parent: { id: string; name: string; round: number; subject: string; html: string; mode: string; toAddress: string | null; ccAddresses: string[]; fromName: string | null; completedAt: string | null; startedAt: string | null; sentFrom: (string | null)[] } | null;
}

/** The email being followed up, shown beside the new one, with the rounds before it. */
export function OriginalEmail({ context }: { context: FollowUpContext }) {
  const p = context.parent;
  if (!p) return null;
  const sentOn = p.completedAt ?? p.startedAt;
  return (
    <details className="rounded-lg border bg-card" open>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
        <span className="font-semibold">The email you are following up</span>
        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-900 dark:bg-sky-950 dark:text-sky-100">Round {p.round}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">“{p.subject}”{sentOn ? ` · sent ${new Date(sentOn).toLocaleDateString()}` : ''}</span>
      </summary>
      <div className="space-y-2 border-t px-3 pb-3 pt-2 text-sm">
        <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Subject</dt><dd className="font-medium">{p.subject}</dd>
          <dt className="text-muted-foreground">Sent from</dt><dd>{p.sentFrom.filter(Boolean).join(', ') || '—'}</dd>
          <dt className="text-muted-foreground">To</dt><dd>{p.mode === 'BCC' ? p.toAddress || '—' : 'each recruiter'}</dd>
          {p.ccAddresses.length > 0 && (<><dt className="text-muted-foreground">CC</dt><dd>{p.ccAddresses.join(', ')}</dd></>)}
          <dt className="text-muted-foreground">Sent as</dt><dd>{p.mode === 'BCC' ? 'BCC groups' : 'Individual copies'}</dd>
        </dl>
        <iframe title="The earlier email" sandbox="" srcDoc={p.html} className="h-72 w-full rounded border bg-white" />
        {context.chain.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">All rounds:</span>
            {context.chain.map((c) => (
              <Link key={c.id} href={c.round > 1 ? `/recruiter-follow-up/${c.id}` : `/recruiter-send/${c.id}`} className={`rounded px-1.5 py-0.5 ring-1 ring-border hover:bg-elevated ${c.current ? 'bg-primary text-primary-foreground ring-primary' : ''}`}>
                Round {c.round} <span className={`ml-1 rounded px-1 ${STATUS_STYLE[c.status] ?? ''}`}>{c.status.toLowerCase()}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

type AudienceKey = 'NOT_REPLIED' | 'NOT_REPLIED_OPENED' | 'NOT_REPLIED_UNOPENED' | 'EVERYONE';
interface Counts { everyone: number; notReplied: number; openedNotReplied: number; unopenedNotReplied: number; replied: number; bounced: number; unknownOpens: number }
interface Candidate { email: string; name: string | null; replied: boolean; opened: boolean | null; bounced: boolean; lastSentAt: string | null; selected: boolean }
interface AudienceData { audience: AudienceKey | null; counts: Counts; selected: number; added: number; total: number; page: number; pages: number; candidates: Candidate[] }

/** Who the follow-up goes to: pick an audience, then tick / untick recruiters or add addresses. */
export function FollowUpAudience({ blastId, editable, onChanged }: { blastId: string; editable: boolean; onChanged: () => void }) {
  const [data, setData] = useState<AudienceData | null>(null);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<'all' | 'selected' | 'replied'>('all');
  const [pick, setPick] = useState<AudienceKey>('NOT_REPLIED');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(`/api/recruiter-follow-ups/${blastId}/audience?page=${page}&show=${show}&q=${encodeURIComponent(search)}`, { cache: 'no-store' }).catch(() => null);
    const j = await res?.json().catch(() => null);
    if (res?.ok && j) {
      setData(j);
      setPick((cur) => j.audience ?? cur);
    }
  }, [blastId, page, show, search]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = setTimeout(() => { setSearch(q.trim()); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [q]);

  async function act(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    const res = await fetch(`/api/recruiter-follow-ups/${blastId}/audience`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    const j = await res?.json().catch(() => ({}));
    setBusy(false);
    if (!res?.ok) {
      toast.error(j?.error ?? 'Could not change the list.');
      return null;
    }
    await load();
    onChanged();
    return j;
  }

  if (!data) return <p className="text-sm text-muted-foreground">Loading the recruiters…</p>;
  const c = data.counts;
  // Opened / not opened are only known for recruiters who got an individual copy.
  const openedKnown = c.notReplied - c.unknownOpens > 0;
  const options: { key: AudienceKey; label: string; count: number; disabled?: boolean; hint?: string }[] = [
    { key: 'NOT_REPLIED', label: 'Not replied', count: c.notReplied },
    { key: 'NOT_REPLIED_OPENED', label: 'Not replied, but opened', count: c.openedNotReplied, disabled: !openedKnown, hint: openedKnown ? undefined : 'Opens are only known for individual copies' },
    { key: 'NOT_REPLIED_UNOPENED', label: 'Not replied and not opened', count: c.unopenedNotReplied, disabled: !openedKnown, hint: openedKnown ? undefined : 'Opens are only known for individual copies' },
    { key: 'EVERYONE', label: 'Everyone who was sent it', count: c.everyone },
  ];

  return (
    <div className="space-y-3 text-sm">
      <fieldset disabled={!editable} className="grid gap-2 sm:grid-cols-2">
        <legend className="sr-only">Audience</legend>
        {options.map((o) => (
          <label key={o.key} title={o.hint} className={`rounded-lg border p-2.5 ${o.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${pick === o.key ? 'border-primary ring-1 ring-primary' : ''}`}>
            <span className="flex items-center gap-2 font-medium">
              <input type="radio" name="audience" disabled={o.disabled} checked={pick === o.key} onChange={() => setPick(o.key)} />
              {o.label}
              <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{o.count.toLocaleString()}</span>
            </span>
            {o.hint && <span className="mt-1 block text-xs text-muted-foreground">{o.hint}</span>}
          </label>
        ))}
      </fieldset>
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || pick === data.audience && data.selected === (options.find((o) => o.key === pick)?.count ?? -1)}
            onClick={async () => {
              if (data.selected > 0 && !confirm('Replace the list below with this audience? Recruiters you ticked or added by hand are reset.')) return;
              const j = await act({ action: 'apply', audience: pick });
              if (j) toast.success(`${Number(j.selected).toLocaleString()} recruiter${j.selected === 1 ? '' : 's'} selected.`);
            }}
            className="rounded border px-3 py-1.5 text-sm hover:bg-elevated disabled:opacity-50"
          >
            Use this audience
          </button>
          <span className="text-xs text-muted-foreground">
            {c.replied.toLocaleString()} replied · {c.bounced.toLocaleString()} bounced (never included)
            {c.unknownOpens > 0 && openedKnown ? ` · ${c.unknownOpens.toLocaleString()} with unknown opens (sent in BCC)` : ''}
          </span>
        </div>
      )}

      <p className="rounded-md border bg-muted/30 px-2.5 py-2">
        <b>{data.selected.toLocaleString()}</b> recruiter{data.selected === 1 ? '' : 's'} will get this follow-up
        {data.added > 0 ? ` (${data.added.toLocaleString()} added by address: they start a new thread)` : ''}. Unsubscribed and bounced addresses are skipped at the check.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email or name" className={`${FIELD} sm:w-64`} aria-label="Search recruiters" />
        <select value={show} onChange={(e) => { setShow(e.target.value as typeof show); setPage(1); }} className="rounded border bg-background px-2 py-1.5 text-sm" aria-label="Which recruiters to list">
          <option value="all">Everyone sent ({c.everyone + c.bounced})</option>
          <option value="selected">Getting this follow-up ({data.selected})</option>
          <option value="replied">Replied ({c.replied})</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              {editable && <th className="w-8 px-2 py-1.5" aria-label="Gets the follow-up" />}
              <th className="px-2 py-1.5 font-medium">Recruiter</th>
              <th className="px-2 py-1.5 font-medium">State</th>
              <th className="px-2 py-1.5 font-medium">Last email</th>
            </tr>
          </thead>
          <tbody>
            {data.candidates.length === 0 && (
              <tr><td colSpan={4} className="px-2 py-4 text-center text-xs text-muted-foreground">No recruiter matches.</td></tr>
            )}
            {data.candidates.map((r) => (
              <tr key={r.email} className="border-t border-border-subtle">
                {editable && (
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={r.selected}
                      disabled={busy || r.bounced}
                      title={r.bounced ? 'Bounced: never included' : undefined}
                      aria-label={`${r.selected ? 'Remove' : 'Add'} ${r.email}`}
                      onChange={() => act({ action: 'select', emails: [r.email], selected: !r.selected })}
                    />
                  </td>
                )}
                <td className="px-2 py-1.5">
                  <div className="font-medium">{r.email}</div>
                  {r.name && <div className="text-xs text-muted-foreground">{r.name}</div>}
                </td>
                <td className="px-2 py-1.5 text-xs">
                  {r.bounced ? <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-800 dark:bg-red-950 dark:text-red-200">bounced</span>
                    : r.replied ? <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-800 dark:bg-green-950 dark:text-green-200">replied</span>
                    : <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">no reply</span>}
                  {r.opened === true && <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-amber-900 dark:bg-amber-950 dark:text-amber-100">opened</span>}
                  {r.opened === false && <span className="ml-1 text-muted-foreground">not opened</span>}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-xs text-muted-foreground">{r.lastSentAt ? new Date(r.lastSentAt).toLocaleDateString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.pages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{data.total.toLocaleString()} recruiters · page {data.page} of {data.pages}</span>
          <span className="flex gap-1">
            <button type="button" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)} className="rounded border px-2 py-1 hover:bg-elevated disabled:opacity-50">Previous</button>
            <button type="button" disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)} className="rounded border px-2 py-1 hover:bg-elevated disabled:opacity-50">Next</button>
          </span>
        </div>
      )}

      {editable && (
        <div className="space-y-1.5 border-t pt-3">
          <label className="block text-xs font-medium" htmlFor="followup-add">Add more addresses (one per line, or separated by commas)</label>
          <textarea id="followup-add" value={adding} onChange={(e) => setAdding(e.target.value)} rows={3} className={`${FIELD} font-mono`} placeholder="priya@company.com&#10;rahul@corp.in" />
          <p className="text-xs text-muted-foreground">An address from this chain goes into its own thread. A new address starts a new thread (and has no list columns, so {'{{variables}}'} need a fallback).</p>
          <button
            type="button"
            disabled={!adding.trim() || busy}
            onClick={async () => {
              const j = await act({ action: 'add', text: adding });
              if (j) {
                toast.success(`${Number(j.added)} added${Number(j.newAddresses) ? ` (${Number(j.newAddresses)} new to this chain)` : ''}.`);
                setAdding('');
              }
            }}
            className="rounded border px-3 py-1.5 text-sm hover:bg-elevated disabled:opacity-50"
          >
            Add to the follow-up
          </button>
        </div>
      )}
    </div>
  );
}

/** What to do when the mailbox that sent the earlier email can't send (chosen while sending). */
export function MailboxDownChoice({ value, onChange, disabled }: { value: 'WAIT' | 'FALLBACK'; onChange: (v: 'WAIT' | 'FALLBACK') => void; disabled?: boolean }) {
  return (
    <fieldset disabled={disabled} className="mb-4 space-y-1 rounded border p-3">
      <legend className="sr-only">If the original mailbox is unavailable</legend>
      <p className="text-xs font-medium">If the mailbox that sent the original email is unavailable (disconnected, paused by Gmail, at a limit)</p>
      <label className="flex items-start gap-2 text-sm">
        <input type="radio" name="mailboxDown" className="mt-1" checked={value === 'WAIT'} onChange={() => onChange('WAIT')} />
        <span>Wait for it <span className="text-xs text-muted-foreground">— the follow-up stays in the original Gmail thread; those emails go out when the mailbox can send again</span></span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="radio" name="mailboxDown" className="mt-1" checked={value === 'FALLBACK'} onChange={() => onChange('FALLBACK')} />
        <span>Use another chosen mailbox <span className="text-xs text-muted-foreground">— goes out at once, but as a new thread (it won’t appear under the original email in the sender’s Gmail)</span></span>
      </label>
    </fieldset>
  );
}
