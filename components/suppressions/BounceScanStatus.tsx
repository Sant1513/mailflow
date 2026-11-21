'use client';

import { useEffect, useState } from 'react';

interface Status {
  connected: number;
  fresh: number;
  never: number;
  oldest: string | null;
  failing: { email: string; error: string }[];
  unreadable: { email: string; status: string }[];
  notices: number;
}

const ago = (iso: string | null): string => {
  if (!iso) return 'not yet';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/**
 * One line that says whether every connected mailbox is being checked for bounce notices (every 15 minutes), and names any
 * mailbox that is not: a mailbox MailFlow cannot read is the one place a bounce can still be missed, so it is never hidden.
 */
export function BounceScanStatus() {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/suppressions/scan-status', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => live && j && setS(j))
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  if (!s || s.connected + s.unreadable.length === 0) return null;
  const problems = s.failing.length + s.unreadable.length;
  const allFresh = s.fresh === s.connected && s.never === 0;
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
    </div>
  );
}
