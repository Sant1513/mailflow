'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Square } from 'lucide-react';
import { CATEGORY_LABEL, isBounceCategory } from '@/lib/email/dsn';

interface MailboxLine {
  email: string;
  user: string;
  state: string;
  readable: boolean;
  lastSyncedAt: string | null;
  notices: number;
  error: string | null;
  suppressions: { total: number; bounced: number; complaints: number; unsubscribed: number; byCategory: Record<string, number> };
  userId: string;
}

interface Status {
  connected: number;
  fresh: number;
  never: number;
  oldest: string | null;
  failing: { email: string; error: string }[];
  unreadable: { email: string; status: string }[];
  notices: number;
  canSync?: boolean;
  mailboxes?: MailboxLine[];
}

/** What the page shows for a mailbox while "Sync now" runs. */
interface Run {
  phase: 'waiting' | 'syncing' | 'done' | 'error';
  notices: number;
  suppressed: number;
  rounds: number;
  error?: string;
}

const MAX_ROUNDS = 8;
const userIdOf = (m: MailboxLine) => m.userId;

const ago = (iso: string | null): string => {
  if (!iso) return 'not yet';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/**
 * One line that says whether every connected mailbox is being checked for bounce notices (every 15 minutes), and names any
 * mailbox that is not: a mailbox MailFlow cannot read is the one place a bounce can still be missed, so it is never hidden.
 * A super admin also gets the per-user table with a "Sync now" button and live progress.
 */
export function BounceScanStatus({ onSynced }: { onSynced?: () => void }) {
  const [s, setS] = useState<Status | null>(null);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(true);
  const [detail, setDetail] = useState<string | null>(null);
  const stop = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/suppressions/scan-status', { cache: 'no-store' });
      if (r.ok) setS(await r.json());
    } catch { /* keep what is shown */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const patch = (email: string, p: Partial<Run>) => setRuns((r) => ({ ...r, [email]: { ...(r[email] ?? { phase: 'waiting', notices: 0, suppressed: 0, rounds: 0 }), ...p } }));

  /** Syncs one mailbox, again and again while older notices are still waiting. */
  async function syncOne(email: string) {
    patch(email, { phase: 'syncing', notices: 0, suppressed: 0, rounds: 0, error: undefined });
    let notices = 0, suppressed = 0;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (stop.current) { patch(email, { phase: 'waiting' }); return; }
      let j: { ok: boolean; error?: string | null; more: boolean; notices: number; suppressed: number } | null = null;
      try {
        const r = await fetch('/api/suppressions/scan-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mailbox: email }) });
        j = r.ok ? await r.json() : null;
        if (!j) { patch(email, { phase: 'error', error: `Server said ${r.status}` }); return; }
      } catch {
        patch(email, { phase: 'error', error: 'Network problem, try again' });
        return;
      }
      notices += j.notices; suppressed += j.suppressed;
      if (!j.ok) { patch(email, { phase: 'error', notices, suppressed, rounds: round, error: j.error ?? 'Could not read this mailbox' }); return; }
      patch(email, { notices, suppressed, rounds: round });
      if (!j.more) { patch(email, { phase: 'done' }); return; }
    }
    patch(email, { phase: 'done', error: 'Older notices are still waiting: press Sync now again' });
  }

  async function syncAll(only?: string[]) {
    if (!s?.mailboxes || running) return;
    const list = only ?? [...s.mailboxes].filter((m) => m.readable).sort((a, b) => (a.lastSyncedAt ?? '').localeCompare(b.lastSyncedAt ?? '')).map((m) => m.email);
    stop.current = false;
    setRunning(true);
    setRuns((r) => { const n = { ...r }; for (const e of list) n[e] = { phase: 'waiting', notices: 0, suppressed: 0, rounds: 0 }; return n; });
    for (const email of list) {
      if (stop.current) break;
      await syncOne(email);
      await refresh();
    }
    setRunning(false);
    onSynced?.();
  }

  if (!s || s.connected + s.unreadable.length === 0) return null;
  const problems = s.failing.length + s.unreadable.length;
  const allFresh = s.fresh === s.connected && s.never === 0;
  const lines = s.mailboxes ?? [];
  const queued = Object.values(runs);
  const finished = queued.filter((r) => r.phase === 'done' || r.phase === 'error').length;
  const totalFound = queued.reduce((n, r) => n + r.notices, 0);
  const totalAdded = queued.reduce((n, r) => n + r.suppressed, 0);

  return (
    <div className={`mb-4 rounded-lg border px-3 py-2 text-xs ${problems ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100' : 'border-border bg-card text-muted-foreground'}`} role="status" data-bounce-scan-status>
      <span className="font-medium text-foreground">Bounce scan:</span>{' '}
      {allFresh ? `all ${s.connected} connected mailboxes were checked in the last hour` : `${s.fresh} of ${s.connected} connected mailboxes checked in the last hour${s.never ? `, ${s.never} not yet` : ''}`}
      {s.oldest ? ` · oldest check ${ago(s.oldest)}` : ''} · {s.notices.toLocaleString()} notices read. New bounces from every connected mailbox are added here automatically, every 15 minutes.
      {s.failing.length > 0 && (
        <div className="mt-1">Could not finish: {s.failing.map((f) => `${f.email} (${f.error})`).join('; ')}</div>
      )}
      {s.unreadable.length > 0 && (
        <div className="mt-1">
          <b>Not being checked</b> (reconnect these in Settings, or their bounces are missed): {s.unreadable.map((u) => `${u.email} (${u.status.toLowerCase()})`).join(', ')}
        </div>
      )}

      {s.canSync && (
        <div className="mt-2 border-t border-current/10 pt-2" data-bounce-sync-panel>
          <div className="flex flex-wrap items-center gap-2">
            <b className="text-foreground">Super admin · sync by user</b>
            {running ? (
              <button className="btn-secondary inline-flex items-center gap-1 px-2 py-1" onClick={() => { stop.current = true; }}>
                <Square className="h-3 w-3" /> Stop after this mailbox
              </button>
            ) : (
              <button className="btn-primary inline-flex items-center gap-1 px-2 py-1" onClick={() => void syncAll()}>
                <RefreshCw className="h-3 w-3" /> Sync all now
              </button>
            )}
            <button className="underline" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Show'} mailboxes ({lines.length})</button>
          </div>
          {queued.length > 0 && (
            <div className="mt-2" aria-live="polite">
              <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${Math.round((finished / queued.length) * 100)}%` }} />
              </div>
              <div className="mt-1">
                {running ? 'Syncing' : 'Finished'}: {finished} of {queued.length} mailboxes · {totalFound.toLocaleString()} notices read · {totalAdded.toLocaleString()} bounces added or confirmed
              </div>
            </div>
          )}
          {open && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-foreground">
                  <tr><th className="py-1 pr-3">User</th><th className="pr-3">Mailbox</th><th className="pr-3">Last synced</th><th className="pr-3 text-right">Notices read</th><th className="pr-3 text-right">On the list</th><th className="pr-3">Status</th><th /></tr>
                </thead>
                <tbody>
                  {lines.map((m) => {
                    const run = runs[m.email];
                    const stale = !m.lastSyncedAt || Date.now() - new Date(m.lastSyncedAt).getTime() > 3600_000;
                    return (
                      <Fragment key={m.email}>
                      <tr className="border-t border-current/10 align-top">
                        <td className="py-1 pr-3 text-foreground">{m.user}</td>
                        <td className="pr-3">{m.email}</td>
                        <td className="pr-3 whitespace-nowrap">{m.readable ? ago(m.lastSyncedAt) : '—'}</td>
                        <td className="pr-3 text-right tabular-nums">{m.notices.toLocaleString()}</td>
                        <td className="pr-3 text-right tabular-nums">
                          <button className="underline" title="Advanced report" onClick={() => setDetail(detail === m.email ? null : m.email)}>{m.suppressions.total.toLocaleString()}</button>
                        </td>
                        <td className="pr-3">
                          {run?.phase === 'syncing' ? <span className="text-foreground">Syncing… round {run.rounds + 1} · {run.notices} read</span>
                            : run?.phase === 'waiting' ? 'Waiting'
                            : run?.phase === 'done' ? <span className="text-green-700 dark:text-green-400">Done · {run.notices} read, {run.suppressed} added/confirmed{run.error ? ` · ${run.error}` : ''}</span>
                            : run?.phase === 'error' ? <span className="text-red-700 dark:text-red-400">Failed · {run.error}</span>
                            : !m.readable ? <span className="text-red-700 dark:text-red-400">Not readable ({m.state.toLowerCase()}): reconnect in Settings</span>
                            : m.error ? <span className="text-amber-700 dark:text-amber-300">{m.error}</span>
                            : stale ? 'Behind' : 'Up to date'}
                        </td>
                        <td className="text-right">
                          {m.readable && (
                            <button className="underline disabled:opacity-40" disabled={running} onClick={() => void syncAll([m.email])}>Sync</button>
                          )}
                        </td>
                      </tr>
                      {detail === m.email && (
                        <tr>
                          <td colSpan={7} className="pb-2 pl-2 text-foreground">
                            <b>{m.user}&apos;s report</b> · {m.suppressions.total.toLocaleString()} on the list: {m.suppressions.bounced.toLocaleString()} bounced, {m.suppressions.complaints.toLocaleString()} spam complaints, {m.suppressions.unsubscribed.toLocaleString()} unsubscribed.
                            {Object.keys(m.suppressions.byCategory).length > 0 && (
                              <div className="mt-0.5 text-muted-foreground">
                                {Object.entries(m.suppressions.byCategory).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${isBounceCategory(c) ? CATEGORY_LABEL[c] : c}: ${n.toLocaleString()}`).join(' · ')}
                              </div>
                            )}
                            <a className="mt-0.5 inline-block underline" href={`/api/suppressions?format=csv&user=${encodeURIComponent(userIdOf(m))}`} download>Download {m.user}&apos;s list (CSV)</a>
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
