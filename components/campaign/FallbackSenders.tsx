'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

interface Mailbox {
  id: string;
  emailAddress: string;
  ownerName: string;
  status: string;
  allowed?: boolean;
}

interface State {
  main: { emailAddress: string; status: string } | null;
  selected: Mailbox[];
  available: Mailbox[];
  sentBy: { emailAddress: string; count: number }[];
  editable: boolean;
}

/**
 * Backup sender mailboxes for a campaign. If the campaign's mailbox reaches
 * Google's daily limit, is asked to slow down, or is disconnected, the next
 * emails go out from these, in order. Only mailboxes whose owners allowed it
 * (Settings → Gmail) can be picked. Editable while the campaign is sending.
 */
export function FallbackSenders({ campaignId, refreshKey }: { campaignId: string; refreshKey?: unknown }) {
  const [state, setState] = useState<State | null>(null);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/campaigns/${campaignId}/fallbacks`);
    if (res.ok) setState(await res.json());
  }, [campaignId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function save(ids: string[]) {
    setBusy(true);
    const res = await fetch(`/api/campaigns/${campaignId}/fallbacks`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountIds: ids }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      toast.error(json.error ?? 'Could not save backup mailboxes');
      return;
    }
    toast.success(ids.length ? 'Backup mailboxes saved' : 'Backup mailboxes removed');
    setAdding('');
    load();
  }

  if (!state) return null;
  const ids = state.selected.map((s) => s.id);
  const addable = state.available.filter((a) => !ids.includes(a.id));
  const move = (i: number, d: -1 | 1) => {
    const next = [...ids];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    save(next);
  };

  return (
    <div className="rounded-lg border bg-card p-4">
      <h2 className="mb-1 text-sm font-semibold">Backup sender mailboxes</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        If {state.main?.emailAddress ?? 'the campaign mailbox'} reaches Google&apos;s daily limit (1,500 emails or 1,800 different recipients a day here), is asked by
        Gmail to slow down, or gets disconnected, the remaining emails go out from these mailboxes in order, at the same 3-second pace.
        Replies to those emails come to the backup mailbox and show on this campaign.
      </p>

      {state.selected.length > 0 ? (
        <ol className="mb-3 space-y-1">
          {state.selected.map((m, i) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
              <span className="text-xs text-muted-foreground">{i + 1}.</span>
              <span className="font-medium">{m.emailAddress}</span>
              <span className="text-xs text-muted-foreground">{m.ownerName}</span>
              {m.status !== 'CONNECTED' && <span className="badge badge-neutral">{m.status.toLowerCase()}</span>}
              {m.allowed === false && <span className="text-[11px] text-amber-700">owner withdrew permission: skipped</span>}
              {state.editable && (
                <span className="ml-auto flex items-center gap-2 text-xs">
                  <button onClick={() => move(i, -1)} disabled={busy || i === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-30" title="Move up">↑</button>
                  <button onClick={() => move(i, 1)} disabled={busy || i === state.selected.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-30" title="Move down">↓</button>
                  <button onClick={() => save(ids.filter((x) => x !== m.id))} disabled={busy} className="text-muted-foreground hover:text-destructive">Remove</button>
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mb-3 text-xs text-muted-foreground">No backup mailboxes. If the campaign mailbox hits a limit, sending waits until it can continue.</p>
      )}

      {state.editable && (
        addable.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            <select value={adding} onChange={(e) => setAdding(e.target.value)} className="min-w-[240px] flex-1 !py-1 text-sm" aria-label="Mailbox to add">
              <option value="">Add a backup mailbox…</option>
              {addable.map((a) => (
                <option key={a.id} value={a.id} disabled={a.status !== 'CONNECTED'}>
                  {a.emailAddress} ({a.ownerName}){a.status !== 'CONNECTED' ? ` · ${a.status.toLowerCase()}` : ''}
                </option>
              ))}
            </select>
            <button onClick={() => adding && save([...ids, adding])} disabled={!adding || busy || ids.length >= 5} className="btn-secondary !py-1 text-xs">
              Add
            </button>
          </div>
        ) : (
          state.selected.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No teammate has allowed their mailbox yet. Each person turns this on in Settings → Gmail (&quot;Allow my mailbox as a backup
              sender&quot;).
            </p>
          )
        )
      )}

      {state.sentBy.length > 1 && (
        <div className="mt-3 border-t pt-2 text-xs text-muted-foreground">
          Sent from:{' '}
          {state.sentBy.map((s, i) => (
            <span key={s.emailAddress}>
              {i > 0 ? ' · ' : ''}
              {s.emailAddress} <span className="font-medium text-foreground">{s.count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
