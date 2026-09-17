'use client';

import { useCallback, useEffect, useState } from 'react';

const PAGE_SIZE = 50;

interface Log {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  metadata: any;
  createdAt: string;
  actor: { name: string; email: string } | null;
}

interface Meta {
  actions: string[];
  users: { id: string; name: string; email: string }[];
  workspaces: { id: string; name: string }[];
}

function badge(action: string) {
  if (action.includes('DELETE') || action.includes('REMOVE')) return 'badge-destructive';
  if (action.includes('CREATE') || action.includes('ADD')) return 'badge-success';
  if (action.includes('SEND') || action.includes('SYNC')) return 'badge-info';
  if (action.includes('APPROVE') || action.includes('RESOLVED')) return 'badge-success';
  if (action.includes('REJECT') || action.includes('FAIL')) return 'badge-warning';
  return 'badge';
}

export default function AuditLogsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const thirtyAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  const [logs, setLogs] = useState<Log[]>([]);
  const [meta, setMeta] = useState<Meta>({ actions: [], users: [], workspaces: [] });
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  // Filters
  const [from, setFrom] = useState(thirtyAgo);
  const [to, setTo] = useState(today);
  const [actorId, setActorId] = useState('');
  const [action, setAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');

  const load = useCallback(async (pg = page) => {
    setLoading(true);
    const p = new URLSearchParams({ page: String(pg) });
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (actorId) p.set('actorId', actorId);
    if (action) p.set('action', action);
    if (targetType) p.set('targetType', targetType);
    if (workspaceId) p.set('workspaceId', workspaceId);

    const res = await fetch(`/api/admin/audit-logs?${p}`);
    setLoading(false);
    if (!res.ok) return;
    const json = await res.json();
    setLogs(json.logs ?? []);
    setTotal(json.total ?? 0);
    if (json.meta) setMeta(json.meta);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, actorId, action, targetType, workspaceId, page]);

  useEffect(() => { load(page); }, [from, to, actorId, action, targetType, workspaceId, page]); // eslint-disable-line

  function reset() {
    setFrom(thirtyAgo);
    setTo(today);
    setActorId('');
    setAction('');
    setTargetType('');
    setWorkspaceId('');
    setPage(1);
  }

  function applyPreset(days: number) {
    setFrom(new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10));
    setTo(new Date().toISOString().slice(0, 10));
    setPage(1);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const fmt = (d: string) => new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="p-6">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">Audit Logs</h1>
          <p className="text-sm text-muted-foreground">Every sensitive action, organization-wide (§95).</p>
        </div>
        {loading && <span className="text-xs text-muted-foreground">Loading…</span>}
      </div>

      {/* Filter bar */}
      <div className="mb-5 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          {/* Date range */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">From</label>
            <input type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); setPage(1); }}
              className="!py-1 text-sm" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">To</label>
            <input type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); setPage(1); }}
              className="!py-1 text-sm" />
          </div>
          {/* Presets */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Quick</label>
            <div className="flex gap-1">
              {[7, 30, 90].map((d) => (
                <button key={d} onClick={() => applyPreset(d)}
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-elevated">{d}d</button>
              ))}
            </div>
          </div>

          {/* Actor */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">User</label>
            <select value={actorId} onChange={(e) => { setActorId(e.target.value); setPage(1); }} className="!py-1 text-sm min-w-[160px]">
              <option value="">All users</option>
              <option value="system">System (no actor)</option>
              {meta.users.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.email.split('@')[0]})</option>
              ))}
            </select>
          </div>

          {/* Workspace */}
          {meta.workspaces.length > 1 && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Workspace</label>
              <select value={workspaceId} onChange={(e) => { setWorkspaceId(e.target.value); setPage(1); }} className="!py-1 text-sm min-w-[140px]">
                <option value="">All workspaces</option>
                {meta.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Action */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Action</label>
            {meta.actions.length > 0 ? (
              <select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} className="!py-1 text-sm min-w-[160px]">
                <option value="">All actions</option>
                {meta.actions.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            ) : (
              <input value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}
                placeholder="e.g. CAMPAIGN_SEND" className="!py-1 text-sm w-40" />
            )}
          </div>

          {/* Target type */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Target type</label>
            <input value={targetType} onChange={(e) => { setTargetType(e.target.value); setPage(1); }}
              placeholder="e.g. Campaign" className="!py-1 text-sm w-32" />
          </div>

          <button onClick={reset} className="btn-secondary !px-3 !py-1 text-xs">Reset</button>
        </div>

        <div className="mt-2 text-xs text-muted-foreground">
          {total.toLocaleString()} event{total !== 1 ? 's' : ''} matched
        </div>
      </div>

      {/* Table */}
      {logs.length === 0 && !loading ? (
        <div className="mt-16 text-center text-sm text-muted-foreground">No audit events match the selected filters.</div>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 whitespace-nowrap">When</th>
                  <th className="px-4 py-2">Actor</th>
                  <th className="px-4 py-2">Action</th>
                  <th className="px-4 py-2">Target</th>
                  <th className="px-4 py-2">IP</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log, i) => (
                  <tr key={log.id} className={`border-t border-border-subtle ${i % 2 === 1 ? 'bg-muted/30' : ''}`}>
                    <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">{fmt(log.createdAt)}</td>
                    <td className="px-4 py-2">
                      {log.actor ? (
                        <>
                          <div className="text-xs font-medium">{log.actor.name}</div>
                          <div className="text-xs text-muted-foreground">{log.actor.email}</div>
                        </>
                      ) : (
                        <span className="text-xs text-faint">system</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`font-mono text-xs ${badge(log.action)}`}>{log.action}</span>
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {log.targetType ? (
                        <>
                          <span className="font-medium text-foreground">{log.targetType}</span>
                          {log.targetId && <span className="ml-1 font-mono text-[10px] text-faint">{log.targetId.slice(-8)}</span>}
                        </>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{log.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between text-sm">
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
                className="btn-secondary !px-3 !py-1 text-xs disabled:opacity-40">← Prev</button>
              <span className="text-muted-foreground">
                Page {page} of {totalPages} · {total.toLocaleString()} total
              </span>
              <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}
                className="btn-secondary !px-3 !py-1 text-xs disabled:opacity-40">Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
