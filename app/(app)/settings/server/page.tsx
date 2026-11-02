'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';

type ServerName = 'cloud' | 'laptop';
interface ServerStatus {
  activeServer: ServerName;
  switchTo: ServerName | null;
  switchStartedAt: string | null;
  switchRequestedBy: string | null;
  lastSyncAt: string | null;
  lastLaptopSeenAt: string | null;
  laptopOnline: boolean;
  note: string | null;
}

const LABEL: Record<ServerName, string> = { cloud: 'Cloud', laptop: 'Laptop' };
const DESCRIPTION: Record<ServerName, string> = {
  cloud: 'Vercel + Supabase. Fast and reachable from anywhere; the laptop keeps a full copy every night.',
  laptop: 'Your laptop server. Speed depends on the laptop being on and its internet; the cloud keeps a copy.',
};

function when(iso: string | null) {
  if (!iso) return 'never';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
  return `${d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} (${ago})`;
}

export default function ServerPage() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/system/server', { cache: 'no-store' }).catch(() => null);
    if (!res) return;
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      setStatus(json);
      setError(null);
    } else setError(json.error ?? 'Could not load the server status.');
  }, []);

  useEffect(() => {
    load();
    // Paused while the tab is hidden (saves the database's monthly data allowance).
    const id = setInterval(() => { if (!document.hidden) load(); }, 10_000);
    return () => clearInterval(id);
  }, [load]);

  async function switchTo(to: ServerName, emergency = false) {
    const message = emergency
      ? 'Emergency switch to the cloud WITHOUT copying from the laptop?\n\nUse this only if the laptop is off or unreachable. Changes made on the laptop since the last copy stay in its backups and will not appear in the cloud.'
      : `Switch MailFlow to the ${LABEL[to].toLowerCase()}?\n\nEveryone sees a short "switching servers" page for about a minute while the data is copied. Nobody is signed out and nothing is lost.`;
    if (!window.confirm(message)) return;
    setBusy(true);
    const res = await fetch('/api/system/server', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, emergency }),
    }).catch(() => null);
    setBusy(false);
    const json = await res?.json().catch(() => ({}));
    if (res?.ok) {
      setStatus(json);
      toast.success(emergency ? 'MailFlow is now on the cloud.' : `Switching to the ${LABEL[to].toLowerCase()}… this page will show "switching servers" for about a minute.`);
    } else toast.error(json?.error ?? 'The switch could not be started.');
  }

  if (error) return <div className="p-6 text-sm text-red-600">{error}</div>;
  if (!status) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const other: ServerName = status.activeServer === 'cloud' ? 'laptop' : 'cloud';
  const canSwitch = !status.switchTo && (other === 'cloud' || status.laptopOnline);

  return (
    <div className="max-w-2xl p-6">
      <Link href="/settings" className="text-sm text-muted-foreground hover:underline">
        ← Settings
      </Link>
      <h1 className="mb-1 mt-2 text-xl font-semibold">Server</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        MailFlow runs on one server at a time; the other keeps a copy. Switching copies everything across first, so no data
        or sign-ins are lost.
      </p>

      <section className="mb-4 rounded-lg border bg-card p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Running on</div>
        <div className="mt-1 text-lg font-semibold">{LABEL[status.activeServer]}</div>
        <p className="mt-1 text-sm text-muted-foreground">{DESCRIPTION[status.activeServer]}</p>
        {status.switchTo && (
          <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
            Switching to the {LABEL[status.switchTo].toLowerCase()} (started {when(status.switchStartedAt)}
            {status.switchRequestedBy ? ` by ${status.switchRequestedBy}` : ''}). Copying the data; this usually takes about a minute.
          </div>
        )}
        {status.note && !status.switchTo && <p className="mt-3 rounded border p-3 text-sm">{status.note}</p>}
      </section>

      <section className="mb-4 rounded-lg border bg-card p-4 text-sm">
        <div className="flex justify-between gap-4 py-1">
          <span className="text-muted-foreground">Laptop server</span>
          <span className={status.laptopOnline ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}>
            {status.laptopOnline ? 'Online' : 'Offline'} · last seen {when(status.lastLaptopSeenAt)}
          </span>
        </div>
        <div className="flex justify-between gap-4 py-1">
          <span className="text-muted-foreground">Last copy between servers</span>
          <span>{when(status.lastSyncAt)}</span>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-4">
        <button
          type="button"
          disabled={!canSwitch || busy}
          onClick={() => switchTo(other)}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Switch to the {LABEL[other].toLowerCase()}
        </button>
        {other === 'laptop' && !status.laptopOnline && (
          <p className="mt-2 text-xs text-muted-foreground">The laptop server is offline, so MailFlow can&apos;t switch to it right now.</p>
        )}
        {other === 'cloud' && !status.switchTo && (
          <div className="mt-4 border-t border-border-subtle pt-3">
            <p className="mb-2 text-xs text-muted-foreground">
              Laptop off or unreachable? MailFlow moves to the cloud by itself after 10 minutes of silence. To move now without
              waiting:
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => switchTo('cloud', true)}
              className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
            >
              Emergency switch to the cloud
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
