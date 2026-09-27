'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

interface SyncResult {
  at: string;
  ok: boolean;
  error?: string;
  created: number;
  updated: number;
  pushedCells: number;
  appended: number;
  duplicateKeys: number;
  partial: boolean;
}

interface Config {
  spreadsheetId: string;
  spreadsheetTitle: string;
  sheetName: string;
  keyHeader: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastResult: SyncResult | null;
  connectedByName: string | null;
}

interface State {
  config: Config | null;
  google: { accountId: string; email: string; hasSheets: boolean } | null;
  connectUrl: string;
}

function when(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
}

function summary(r: SyncResult) {
  if (!r.ok) return r.error ?? 'Failed';
  const parts = [
    r.created && `${r.created} new row${r.created !== 1 ? 's' : ''}`,
    r.updated && `${r.updated} row${r.updated !== 1 ? 's' : ''} updated from the sheet`,
    r.pushedCells && `${r.pushedCells} cell${r.pushedCells !== 1 ? 's' : ''} written to the sheet`,
    r.appended && `${r.appended} row${r.appended !== 1 ? 's' : ''} added to the sheet`,
    r.duplicateKeys && `${r.duplicateKeys} duplicate key${r.duplicateKeys !== 1 ? 's' : ''} skipped`,
  ].filter(Boolean);
  return (parts.length ? parts.join(' · ') : 'Already in sync') + (r.partial ? ' · more to do, continues on the next sync' : '');
}

/**
 * Google Sheets as a live data source for a dataset: connect a sheet, pick
 * the column rows are matched by, then it syncs both ways every 15 minutes
 * (or on "Sync now").
 */
export function SheetSyncPanel({ datasetId, onSynced }: { datasetId: string; onSynced: () => void }) {
  const [state, setState] = useState<State | null>(null);
  const [url, setUrl] = useState('');
  const [inspect, setInspect] = useState<{ title: string; tabs: string[]; tab: string; headers: string[]; rowCount: number } | null>(null);
  const [tab, setTab] = useState('');
  const [keyHeader, setKeyHeader] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/datasets/${datasetId}/sheet-sync`);
    if (res.ok) setState(await res.json());
  }, [datasetId]);

  useEffect(() => {
    load();
  }, [load]);

  async function post(body: Record<string, unknown>, label: string) {
    setBusy(label);
    const res = await fetch(`/api/datasets/${datasetId}/sheet-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      toast.error(json.error ?? 'Something went wrong', { duration: 10000 });
      return null;
    }
    return json;
  }

  async function doInspect(sheetName?: string) {
    const json = await post({ action: 'inspect', url, sheetName }, 'inspect');
    if (!json) return;
    setInspect(json);
    setTab(json.tab);
    const guess = (json.headers as string[]).find((h) => /e-?mail/i.test(h)) ?? json.headers[0] ?? '';
    setKeyHeader((k) => (k && json.headers.includes(k) ? k : guess));
  }

  async function connect() {
    if (!confirm(`Connect "${inspect?.title}" › ${tab}? Rows are matched by "${keyHeader}". The first sync imports the sheet without running automations.`)) return;
    const json = await post({ action: 'connect', url, sheetName: tab, keyHeader }, 'connect');
    if (!json) return;
    const r = json.result as SyncResult;
    if (r.ok) toast.success(`Connected. ${summary(r)}`, { duration: 8000 });
    else toast.error(r.error ?? 'Connected, but the first sync failed', { duration: 10000 });
    setInspect(null);
    setUrl('');
    await load();
    onSynced();
  }

  async function syncNow() {
    const json = await post({ action: 'sync' }, 'sync');
    if (!json) return;
    const r = json.result as SyncResult;
    if (r.ok) toast.success(summary(r), { duration: 8000 });
    else toast.error(r.error ?? 'Sync failed', { duration: 10000 });
    await load();
    onSynced();
  }

  if (!state) return <div className="mb-3 rounded-md border p-3 text-xs text-muted-foreground">Loading…</div>;
  const { config, google } = state;

  return (
    <div className="mb-3 max-w-3xl rounded-md border p-3 text-xs">
      <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Google Sheet: two-way sync</div>

      {config ? (
        <div className="space-y-2">
          <div>
            <a
              href={`https://docs.google.com/spreadsheets/d/${config.spreadsheetId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary hover:underline"
            >
              {config.spreadsheetTitle || 'Spreadsheet'} › {config.sheetName}
            </a>
            <span className="ml-2 text-muted-foreground">
              matched by <strong>{config.keyHeader}</strong>
              {config.connectedByName ? ` · connected by ${config.connectedByName}` : ''}
            </span>
            {!config.enabled && <span className="badge badge-neutral ml-2">Paused</span>}
          </div>
          <div className="text-muted-foreground">
            Last sync: {when(config.lastResult?.at ?? config.lastSyncedAt)}
            {config.lastResult && (
              <span className={config.lastResult.ok ? '' : 'text-destructive'}> · {summary(config.lastResult)}</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={syncNow} disabled={!!busy} className="btn-primary !py-1 text-[11px]">
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              onClick={async () => {
                if (await post({ action: 'enable', enabled: !config.enabled }, 'enable')) load();
              }}
              disabled={!!busy}
              className="btn-secondary !py-1 text-[11px]"
            >
              {config.enabled ? 'Pause auto-sync' : 'Resume auto-sync'}
            </button>
            <button
              onClick={async () => {
                if (!confirm('Disconnect this sheet? Rows already in MailFlow stay; nothing is deleted in the sheet.')) return;
                if (await post({ action: 'disconnect' }, 'disconnect')) load();
              }}
              disabled={!!busy}
              className="text-muted-foreground hover:text-destructive"
            >
              Disconnect
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Syncs every 15 minutes. Sheet edits come into MailFlow; cells edited in MailFlow since the last sync go to the sheet, as do
            signing status, signed date and document link. New sheet rows are added here, and rows added here are added to the sheet. Nothing is
            deleted on either side.
          </p>
        </div>
      ) : !google ? (
        <p className="text-muted-foreground">Connect your Gmail in Settings first; Sheets access is added to the same Google connection.</p>
      ) : !google.hasSheets ? (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            Give MailFlow access to Google Sheets for <strong>{google.email}</strong>. Your Gmail connection stays as it is.
          </p>
          <a href={state.connectUrl} className="btn-primary inline-block !py-1 text-[11px]">
            Connect Google Sheets
          </a>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setInspect(null);
              }}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              className="flex-1 !py-1 text-xs"
            />
            <button onClick={() => doInspect()} disabled={!url.trim() || !!busy} className="btn-secondary !py-1 text-[11px]">
              {busy === 'inspect' ? 'Opening…' : 'Open sheet'}
            </button>
          </div>
          {inspect && (
            <div className="space-y-2 rounded-md border bg-muted/20 p-2">
              <div className="font-medium">{inspect.title}</div>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-[11px] text-muted-foreground">
                  Tab
                  <select
                    value={tab}
                    onChange={(e) => {
                      setTab(e.target.value);
                      doInspect(e.target.value);
                    }}
                    className="w-full !py-1 text-xs"
                  >
                    {inspect.tabs.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label className="text-[11px] text-muted-foreground">
                  Match rows by (a column with one unique value per row, e.g. email)
                  <select value={keyHeader} onChange={(e) => setKeyHeader(e.target.value)} className="w-full !py-1 text-xs">
                    {inspect.headers.map((h) => (
                      <option key={h}>{h}</option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {inspect.rowCount} row{inspect.rowCount !== 1 ? 's' : ''} · columns: {inspect.headers.join(', ') || 'none (row 1 is empty)'}
              </p>
              <button onClick={connect} disabled={!keyHeader || !!busy} className="btn-primary !py-1 text-[11px]">
                {busy === 'connect' ? 'Connecting and syncing…' : 'Connect and sync'}
              </button>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            Signed in to Google as {google.email}. The sheet must be shared with this account (Editor, so MailFlow can write back).
          </p>
        </div>
      )}
    </div>
  );
}
