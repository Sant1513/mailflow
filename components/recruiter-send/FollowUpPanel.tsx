'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
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

export type Segment = 'NO_REPLY_OPENED' | 'NO_REPLY_UNOPENED' | 'NO_REPLY_UNKNOWN' | 'REPLIED';
interface Counts { NO_REPLY_OPENED: number; NO_REPLY_UNOPENED: number; NO_REPLY_UNKNOWN: number; REPLIED: number; bounced: number; total: number }
interface Candidate { email: string; name: string | null; segment: Segment | null; replied: boolean; opened: boolean | null; bounced: boolean; lastSentAt: string | null; selected: boolean }
interface AudienceData { segments: Segment[]; counts: Counts; selected: number; added: number; total: number; page: number; pages: number; candidates: Candidate[] }

export const SEGMENTS: { key: Segment; label: string; hint: string }[] = [
  { key: 'NO_REPLY_OPENED', label: 'No reply, opened it', hint: 'Opened the last email (individual copies only)' },
  { key: 'NO_REPLY_UNOPENED', label: 'No reply, did not open it', hint: 'Did not open the last email (individual copies only)' },
  { key: 'NO_REPLY_UNKNOWN', label: 'No reply, opens unknown', hint: 'The last email went out in BCC, so opens are not tracked per person' },
  { key: 'REPLIED', label: 'Already replied', hint: 'Answered this or an earlier email' },
];
export const NO_REPLY: Segment[] = ['NO_REPLY_OPENED', 'NO_REPLY_UNOPENED', 'NO_REPLY_UNKNOWN'];
const sameSet = (a: Segment[], b: Segment[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Who the follow-up goes to: tick any segments, then tick / untick recruiters or add addresses. */
export function FollowUpAudience({ blastId, editable, onChanged }: { blastId: string; editable: boolean; onChanged: () => void }) {
  const [data, setData] = useState<AudienceData | null>(null);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<'all' | 'selected' | 'replied'>('all');
  const [pick, setPick] = useState<Segment[]>(NO_REPLY);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState('');
  const loaded = useRef(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/recruiter-follow-ups/${blastId}/audience?page=${page}&show=${show}&q=${encodeURIComponent(search)}`, { cache: 'no-store' }).catch(() => null);
    const j = await res?.json().catch(() => null);
    if (res?.ok && j) {
      setData(j);
      // The ticks start from what was saved; after that they are the person's own until applied.
      if (!loaded.current) setPick((cur) => { const saved = (j.segments as Segment[]).filter((k) => j.counts[k] > 0); return (j.segments as Segment[]).length ? saved : cur; });
      loaded.current = true;
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
  const inPick = pick.reduce((n, k) => n + c[k], 0);
  // A saved group with nobody in it shows unticked, so it is left out of the comparison.
  const unchanged = sameSet(pick, data.segments.filter((k) => c[k] > 0)) && data.selected === inPick && data.added === 0;
  const toggle = (k: Segment) => setPick((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  const everyone = SEGMENTS.map((x) => x.key);

  return (
    <div className="space-y-3 text-sm">
      <fieldset disabled={!editable} className="space-y-2">
        <legend className="sr-only">Who gets the follow-up</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {SEGMENTS.map((o) => {
            const empty = c[o.key] === 0;
            return (
              <label key={o.key} title={o.hint} className={`rounded-lg border p-2.5 ${empty && !pick.includes(o.key) ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${pick.includes(o.key) ? 'border-primary ring-1 ring-primary' : ''}`}>
                <span className="flex items-center gap-2 font-medium">
                  <input type="checkbox" disabled={empty && !pick.includes(o.key)} checked={pick.includes(o.key)} onChange={() => toggle(o.key)} />
                  {o.label}
                  <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{c[o.key].toLocaleString()}</span>
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">{o.hint}</span>
              </label>
            );
          })}
        </div>
        {editable && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-muted-foreground">Quick pick:</span>
            <button type="button" onClick={() => setPick(NO_REPLY)} className="text-primary hover:underline">Everyone who has not replied</button>
            <button type="button" onClick={() => setPick(everyone)} className="text-primary hover:underline">Everyone</button>
            <button type="button" onClick={() => setPick([])} className="text-primary hover:underline">Clear</button>
          </div>
        )}
      </fieldset>
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || unchanged}
            onClick={async () => {
              if (data.selected > 0 && !confirm('Replace the list below with these groups? Recruiters you ticked, unticked or added by hand are reset.')) return;
              const j = await act({ action: 'apply', segments: pick });
              if (j) toast.success(`${Number(j.selected).toLocaleString()} recruiter${j.selected === 1 ? '' : 's'} selected.`);
            }}
            className="rounded border px-3 py-1.5 text-sm hover:bg-elevated disabled:opacity-50"
          >
            Use {inPick.toLocaleString()} selected
          </button>
          <span className="text-xs text-muted-foreground">
            {pick.length === 0 ? 'Tick at least one group, or tick recruiters by hand below.' : unchanged ? 'This is the list below.' : 'Not applied yet.'} {c.bounced.toLocaleString()} bounced or unsubscribed (never included).
          </span>
        </div>
      )}
      {pick.includes('REPLIED') && c.REPLIED > 0 && (
        <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          This includes {c.REPLIED.toLocaleString()} recruiter{c.REPLIED === 1 ? '' : 's'} who already replied. If one of them replies again before the follow-up goes out, they are dropped.
        </p>
      )}

      <p className="rounded-md border bg-muted/30 px-2.5 py-2">
        <b>{data.selected.toLocaleString()}</b> recruiter{data.selected === 1 ? '' : 's'} will get this follow-up
        {data.added > 0 ? ` (${data.added.toLocaleString()} added by address: they start a new thread)` : ''}. Unsubscribed and bounced addresses are skipped at the check.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email or name" className={`${FIELD} sm:w-64`} aria-label="Search recruiters" />
        <select value={show} onChange={(e) => { setShow(e.target.value as typeof show); setPage(1); }} className="rounded border bg-background px-2 py-1.5 text-sm" aria-label="Which recruiters to list">
          <option value="all">Everyone sent ({c.total})</option>
          <option value="selected">Getting this follow-up ({data.selected})</option>
          <option value="replied">Replied ({c.REPLIED})</option>
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
                      title={r.bounced ? 'Bounced, rejected or unsubscribed: never included' : undefined}
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
                  {r.bounced ? <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-800 dark:bg-red-950 dark:text-red-200">undeliverable</span>
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

/** How the follow-up goes out: in the original Gmail thread (same subject), or as an individual new email. Asked every time. */
export function FollowUpTypeChoice({ value, onChange, disabled }: { value: 'THREAD' | 'NEW'; onChange: (v: 'THREAD' | 'NEW') => void; disabled?: boolean }) {
  // The page can show this twice (step 3 and the send step): each copy needs its own radio group.
  const group = useId();
  return (
    <fieldset disabled={disabled} className="mb-4 space-y-1 rounded border border-primary/40 bg-primary/5 p-3" data-follow-up-type>
      <legend className="sr-only">How to send this follow-up</legend>
      <p className="text-xs font-medium">How do you want to send this follow-up?</p>
      <label className="flex items-start gap-2 text-sm">
        <input type="radio" name={group} className="mt-1" checked={value === 'THREAD'} onChange={() => onChange('THREAD')} />
        <span>On the same thread <span className="text-xs text-muted-foreground">— a reply under the original email in the same Gmail conversation, from the mailbox that sent it, with the same subject (the subject is kept as it was)</span></span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="radio" name={group} className="mt-1" checked={value === 'NEW'} onChange={() => onChange('NEW')} />
        <span>Individual new email <span className="text-xs text-muted-foreground">— a separate email, its own conversation, with a subject you can change; goes out from any mailbox you tick</span></span>
      </label>
    </fieldset>
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
