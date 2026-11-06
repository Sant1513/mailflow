'use client';

import { useEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { EmailViewer } from '@/components/recruiter-send/EmailViewer';

interface RecipientEmail {
  email: string;
  name: string | null;
  personal: boolean;
  subject: string;
  html: string;
  values: { name: string; value: string; empty: boolean; fallback: boolean }[];
  row: [string, string][];
  status: string;
  skipReason: string | null;
  sentAt: string | null;
  batch: number | null;
  from: string | null;
}

export interface PanelEnvelope {
  mode: 'BCC' | 'INDIVIDUAL';
  fromName: string | null;
  toAddress: string | null;
  ccAddresses: string[];
  replyTo: string | null;
  /** From the plan (before sending): the batch, round and mailbox; null after sending (the server knows). */
  batch?: number | null;
  round?: number | null;
  mailbox?: string | null;
  batchSize?: number | null;
  skipped?: string | null;
}

/**
 * One recruiter's own email beside the list: who it's from and to, their {{Column}} values,
 * and the email exactly as they get it. ‹ › (or ↑ ↓ in the list) step through recruiters.
 * `version` changes when the email changes, so a cached preview is never stale.
 */
export function RecipientPanel({
  blastId,
  email,
  version,
  envelope,
  position,
  onStep,
  onClose,
}: {
  blastId: string;
  email: string;
  version: string;
  envelope: PanelEnvelope;
  position?: { index: number; total: number };
  onStep?: (delta: number) => void;
  onClose?: () => void;
}) {
  const cache = useRef(new Map<string, RecipientEmail>());
  const [data, setData] = useState<RecipientEmail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const key = `${email}|${version}`;
    const hit = cache.current.get(key);
    setError(null);
    if (hit) {
      setData(hit);
      return;
    }
    let live = true;
    setLoading(true);
    fetch(`/api/recruiter-blasts/${blastId}/preview?email=${encodeURIComponent(email)}`, { cache: 'no-store' })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok) throw new Error(j.error ?? 'Could not load this recruiter’s email.');
        cache.current.set(key, j);
        setData(j);
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [blastId, email, version]);

  const e = envelope;
  const shown = data && data.email === email ? data : null;
  const from = shown?.from ?? e.mailbox ?? null;
  const skipped = e.skipped ?? (shown?.status === 'SKIPPED' ? shown.skipReason : null);
  const rows: [string, React.ReactNode][] = [
    ['From', from ? `${e.fromName ? `${e.fromName} ` : ''}<${from}>` : <span className="text-warning">a chosen mailbox, when one has room</span>],
    ['To', e.mode === 'BCC' ? e.toAddress || '—' : email],
    ...(e.mode === 'BCC' ? [['Bcc', `${email}${e.batchSize && e.batchSize > 1 ? ` + ${(e.batchSize - 1).toLocaleString()} more (hidden from each other)` : ''}`] as [string, React.ReactNode]] : []),
    ...(e.ccAddresses.length ? [['CC', e.ccAddresses.join(', ')] as [string, React.ReactNode]] : []),
    ['Reply-To', e.replyTo ? `${e.replyTo}, ${from ?? 'the sending mailbox'}` : from ?? 'the sending mailbox'],
  ];
  const batch = shown?.batch ?? e.batch ?? null;

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Avatar email={email} name={shown?.name ?? null} size={26} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{shown?.name || email}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {shown?.name ? `${email} · ` : ''}
            {batch != null ? `${e.mode === 'BCC' ? 'batch' : 'email'} #${batch}` : 'no batch yet'}
            {e.round != null ? ` · round ${e.round}` : ''}
            {shown?.status === 'SENT' && shown.sentAt ? ` · sent ${new Date(shown.sentAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}
          </div>
        </div>
        {onStep && position && (
          <div className="flex shrink-0 items-center gap-1 text-xs">
            <button type="button" onClick={() => onStep(-1)} disabled={position.index <= 0} className="rounded border px-1.5 py-0.5 hover:bg-elevated disabled:opacity-40" aria-label="Previous recruiter">‹</button>
            <span className="tabular-nums text-muted-foreground">{position.index + 1}/{position.total}</span>
            <button type="button" onClick={() => onStep(1)} disabled={position.index >= position.total - 1} className="rounded border px-1.5 py-0.5 hover:bg-elevated disabled:opacity-40" aria-label="Next recruiter">›</button>
          </div>
        )}
        {onClose && <button type="button" onClick={onClose} className="shrink-0 rounded px-1.5 text-muted-foreground hover:bg-elevated" aria-label="Close">✕</button>}
      </div>

      {skipped && <p className="border-b bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">Skipped: {skipped} This is what they would have got.</p>}

      <dl className="space-y-0.5 border-b px-3 py-2 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-1">
            <dt className="w-16 shrink-0 text-muted-foreground">{k}:</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
        <div className="flex gap-1 pt-0.5">
          <dt className="w-16 shrink-0 text-muted-foreground">Subject:</dt>
          <dd className="min-w-0 break-words font-semibold">{shown?.subject ?? '…'}</dd>
        </div>
      </dl>

      {shown && shown.values.length > 0 && (
        <div className="border-b px-3 py-2 text-xs">
          <div className="mb-1 font-medium">{shown.personal ? 'Their values' : 'Variables (not filled in: BCC sends one email to many)'}</div>
          <div className="flex flex-wrap gap-1">
            {shown.values.map((v) => (
              <span key={v.name} className={`max-w-full truncate rounded px-1.5 py-0.5 ring-1 ${v.empty && !v.fallback ? 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900' : 'bg-muted/40 ring-border'}`} title={v.value}>
                <span className="font-mono text-muted-foreground">{`{{${v.name}}}`}</span> {v.empty ? (v.fallback ? <i>fallback</i> : <b>empty: will be skipped</b>) : v.value}
              </span>
            ))}
          </div>
        </div>
      )}

      {error ? (
        <p className="p-4 text-sm text-red-600">{error}</p>
      ) : (
        <div className={loading && !shown ? 'opacity-50' : ''}>
          <EmailViewer html={shown?.html ?? ''} storageKey="recruiter-person" defaultHeight={460} empty={loading ? 'Loading their email…' : 'Nothing to preview yet.'} />
        </div>
      )}
      {shown && shown.row.length > 0 && (
        <details className="border-t px-3 py-1.5 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Their row in your list</summary>
          <dl className="mt-1 grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
            {shown.row.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="truncate text-muted-foreground">{k}</dt>
                <dd className="break-all">{v || <span className="text-faint">—</span>}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}
