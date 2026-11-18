'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { NO_REPLY, SEGMENTS, type Segment } from '@/components/recruiter-send/FollowUpPanel';

/** Pieces of the Quick Send screen in follow-up mode: the earlier email and who gets the follow-up. */

const FIELD = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none';
const EMAIL_IN_TEXT = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export interface FollowUpCandidate { email: string; name: string | null; segment: Segment | null; replied: boolean; opened: boolean; undeliverable: boolean; lastSentAt: string | null }
export interface FollowUpDetail {
  parent: { id: string; name: string; round: number; subject: string; html: string; sentFrom: string[]; finishedAt: string; cc: string[]; bcc: string[]; fromName: string | null; replyTo: string | null };
  suggestedSubject: string;
  chain: { id: string; name: string; round: number; status: string; current: boolean }[];
  counts: { NO_REPLY_OPENED: number; NO_REPLY_UNOPENED: number; NO_REPLY_UNKNOWN: number; REPLIED: number; bounced: number; total: number };
  openFollowUp: { id: string; status: string } | null;
  candidates: FollowUpCandidate[];
  defaultSegments: Segment[];
}

/** Everyone in the given groups (never an undeliverable address). */
export function emailsInSegments(candidates: FollowUpCandidate[], segs: Segment[]): string[] {
  return candidates.filter((c) => !c.undeliverable && c.segment && segs.includes(c.segment)).map((c) => c.email);
}

/** Valid addresses in free text, lower-cased and unique. */
export function addressesIn(text: string): string[] {
  return [...new Set((text.match(EMAIL_IN_TEXT) ?? []).map((e) => e.toLowerCase()))];
}

/** The send being followed up, shown beside the new email. */
export function OriginalQuickEmail({ detail }: { detail: FollowUpDetail }) {
  const p = detail.parent;
  return (
    <details className="rounded-lg border bg-card" open>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3 text-sm">
        <span className="font-semibold">The email you are following up</span>
        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-900 dark:bg-sky-950 dark:text-sky-100">Round {p.round}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">“{p.subject}” · sent {new Date(p.finishedAt).toLocaleDateString()}</span>
      </summary>
      <div className="space-y-2 border-t px-4 pb-4 pt-3 text-sm">
        <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Subject</dt><dd className="font-medium">{p.subject}</dd>
          <dt className="text-muted-foreground">Sent from</dt><dd>{p.sentFrom.filter(Boolean).join(', ') || '—'}</dd>
          {p.cc.length > 0 && (<><dt className="text-muted-foreground">Cc</dt><dd>{p.cc.join(', ')}</dd></>)}
          {p.bcc.length > 0 && (<><dt className="text-muted-foreground">Bcc</dt><dd>{p.bcc.join(', ')}</dd></>)}
        </dl>
        <iframe title="The earlier email" sandbox="" srcDoc={p.html} className="h-64 w-full rounded border bg-white" />
        {detail.chain.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">All rounds:</span>
            {detail.chain.map((c) => (
              <Link key={c.id} href={`/campaigns/${c.id}`} className={`rounded px-1.5 py-0.5 ring-1 ring-border hover:bg-elevated ${c.current ? 'bg-primary text-primary-foreground ring-primary' : ''}`}>
                Round {c.round} <span className="opacity-70">{c.status.toLowerCase().replace(/_/g, ' ')}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

/** Who gets the follow-up: tick groups (they add up), tick or untick people, add addresses. */
export function QuickFollowUpAudience({
  detail, segs, onSegs, picked, onPicked, extra, onExtra,
}: {
  detail: FollowUpDetail;
  segs: Segment[];
  onSegs: (s: Segment[]) => void;
  picked: Set<string>;
  onPicked: (s: Set<string>) => void;
  extra: string;
  onExtra: (t: string) => void;
}) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const c = detail.counts;
  const known = useMemo(() => new Set(detail.candidates.map((x) => x.email)), [detail.candidates]);
  const typed = useMemo(() => addressesIn(extra), [extra]);
  const newTyped = typed.filter((e) => !known.has(e));
  const chainTyped = typed.filter((e) => known.has(e));
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return detail.candidates.filter((x) => !needle || x.email.includes(needle) || (x.name ?? '').toLowerCase().includes(needle)).sort((a, b) => a.email.localeCompare(b.email));
  }, [detail.candidates, q]);
  const PAGE = 50;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const at = Math.min(page, pages);
  const shown = rows.slice((at - 1) * PAGE, at * PAGE);

  const chooseSegs = (next: Segment[]) => {
    onSegs(next);
    onPicked(new Set(emailsInSegments(detail.candidates, next)));
  };
  const toggleSeg = (k: Segment) => chooseSegs(segs.includes(k) ? segs.filter((x) => x !== k) : [...segs, k]);
  const toggle = (email: string) => {
    const next = new Set(picked);
    if (next.has(email)) next.delete(email);
    else next.add(email);
    onPicked(next);
  };
  const total = new Set([...picked, ...typed.filter((e) => !detail.candidates.find((x) => x.email === e)?.undeliverable)]).size;

  return (
    <div className="space-y-3 text-sm">
      <div className="grid gap-2 sm:grid-cols-2">
        {SEGMENTS.map((o) => {
          const empty = c[o.key] === 0;
          return (
            <label key={o.key} title={o.hint} className={`rounded-lg border p-2.5 ${empty && !segs.includes(o.key) ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${segs.includes(o.key) ? 'border-primary ring-1 ring-primary' : ''}`}>
              <span className="flex items-center gap-2 font-medium">
                <input type="checkbox" disabled={empty && !segs.includes(o.key)} checked={segs.includes(o.key)} onChange={() => toggleSeg(o.key)} />
                {o.label}
                <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{c[o.key].toLocaleString()}</span>
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">{o.hint}</span>
            </label>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground">Quick pick:</span>
        <button type="button" onClick={() => chooseSegs(NO_REPLY.filter((k) => c[k] > 0))} className="text-primary hover:underline">Everyone who has not replied</button>
        <button type="button" onClick={() => chooseSegs(SEGMENTS.map((s) => s.key).filter((k) => c[k] > 0))} className="text-primary hover:underline">Everyone</button>
        <button type="button" onClick={() => chooseSegs([])} className="text-primary hover:underline">Clear</button>
        <span className="ml-auto text-muted-foreground">{c.bounced.toLocaleString()} bounced or unsubscribed (never included)</span>
      </div>
      {segs.includes('REPLIED') && c.REPLIED > 0 && (
        <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          This includes {c.REPLIED.toLocaleString()} {c.REPLIED === 1 ? 'person' : 'people'} who already replied.
        </p>
      )}
      <p className="rounded-md border bg-muted/30 px-2.5 py-2">
        <b>{total.toLocaleString()}</b> {total === 1 ? 'person' : 'people'} will get this follow-up
        {newTyped.length > 0 ? ` (${newTyped.length} added by address start a new thread)` : ''}. Unsubscribed and bounced addresses are skipped at the check.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search email or name" className={`${FIELD} sm:w-64`} aria-label="Search people" />
        <span className="text-xs text-muted-foreground">{rows.length.toLocaleString()} of {c.total.toLocaleString()} people</span>
      </div>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="w-8 px-2 py-1.5" aria-label="Gets the follow-up" />
              <th className="px-2 py-1.5 font-medium">Person</th>
              <th className="px-2 py-1.5 font-medium">State</th>
              <th className="px-2 py-1.5 font-medium">Last email</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={4} className="px-2 py-4 text-center text-muted-foreground">Nobody matches.</td></tr>}
            {shown.map((r) => (
              <tr key={r.email} className="border-t border-border-subtle">
                <td className="px-2 py-1.5">
                  <input type="checkbox" checked={picked.has(r.email)} disabled={r.undeliverable} title={r.undeliverable ? 'Bounced, rejected or unsubscribed: never included' : undefined} aria-label={`${picked.has(r.email) ? 'Remove' : 'Add'} ${r.email}`} onChange={() => toggle(r.email)} />
                </td>
                <td className="px-2 py-1.5"><div className="font-medium">{r.email}</div>{r.name && <div className="text-muted-foreground">{r.name}</div>}</td>
                <td className="px-2 py-1.5">
                  {r.undeliverable ? <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-800 dark:bg-red-950 dark:text-red-200">undeliverable</span>
                    : r.replied ? <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-800 dark:bg-green-950 dark:text-green-200">replied</span>
                    : <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">no reply</span>}
                  {!r.undeliverable && !r.replied && (r.opened ? <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-amber-900 dark:bg-amber-950 dark:text-amber-100">opened</span> : <span className="ml-1 text-muted-foreground">not opened</span>)}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">{r.lastSentAt ? new Date(r.lastSentAt).toLocaleDateString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Page {at} of {pages}</span>
          <span className="flex gap-1">
            <button type="button" disabled={at <= 1} onClick={() => setPage(at - 1)} className="rounded border px-2 py-1 hover:bg-elevated disabled:opacity-50">Previous</button>
            <button type="button" disabled={at >= pages} onClick={() => setPage(at + 1)} className="rounded border px-2 py-1 hover:bg-elevated disabled:opacity-50">Next</button>
          </span>
        </div>
      )}

      <div className="space-y-1.5 border-t pt-3">
        <label className="block text-xs font-medium" htmlFor="qfu-extra">Add more addresses (one per line, or separated by commas)</label>
        <textarea id="qfu-extra" value={extra} onChange={(e) => onExtra(e.target.value)} rows={3} className={`${FIELD} font-mono`} placeholder={'priya@company.com\nrahul@corp.in'} />
        <p className="text-xs text-muted-foreground">
          {typed.length ? `${typed.length} address${typed.length === 1 ? '' : 'es'} found: ${chainTyped.length} already in this chain (their own thread), ${newTyped.length} new (a new thread, no list columns).` : 'An address from this chain goes into its own thread. A new address starts a new thread.'}
        </p>
      </div>
    </div>
  );
}
