'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Kpis {
  total: number;
  openCount: number;
  resolvedCount: number;
  unreadCount: number;
  resolutionRate: number;
  replyRate: number;
  frtFormatted: string;
  artFormatted: string;
  resolutionFormatted: string;
}

interface AgentRow {
  userId: string;
  name: string;
  email: string;
  total: number;
  responded: number;
  resolvedCount: number;
  resolutionRate: number;
  frtFormatted: string;
  artFormatted: string;
}

interface TrendPoint {
  day: string;
  opened: number;
  resolved: number;
}

interface Member { id: string; name: string; email: string; }
interface Tag { id: string; name: string; }

function KpiCard({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: 'good' | 'warn' | 'neutral' }) {
  const color = tone === 'good' ? 'text-success' : tone === 'warn' ? 'text-warning' : 'text-foreground';
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-faint">{sub}</div>}
    </div>
  );
}

// Tiny sparkline bar chart
function MiniBarChart({ data }: { data: TrendPoint[] }) {
  if (!data.length) return null;
  const maxVal = Math.max(...data.map((d) => Math.max(d.opened, d.resolved)), 1);
  return (
    <div className="mt-4 rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold">Conversation trend</span>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-primary/70" />Opened</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-success/70" />Resolved</span>
        </div>
      </div>
      <div className="flex items-end gap-px overflow-x-auto" style={{ height: 80 }}>
        {data.map((d) => (
          <div key={d.day} className="group relative flex min-w-0 flex-1 flex-col items-center gap-px" title={`${d.day}: ${d.opened} opened, ${d.resolved} resolved`}>
            <div className="w-full rounded-t-sm bg-primary/70" style={{ height: `${(d.opened / maxVal) * 70}px` }} />
            <div className="w-full rounded-t-sm bg-success/70" style={{ height: `${(d.resolved / maxVal) * 70}px` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-faint">
        <span>{data[0]?.day}</span>
        <span>{data[data.length - 1]?.day}</span>
      </div>
    </div>
  );
}

export default function PerformancePage() {
  const today = new Date().toISOString().slice(0, 10);
  const thirtyAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  const [from, setFrom] = useState(thirtyAgo);
  const [to, setTo] = useState(today);
  const [assigneeId, setAssigneeId] = useState('');
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');

  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [loading, setLoading] = useState(false);

  const [members, setMembers] = useState<Member[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);

  useEffect(() => {
    fetch('/api/members').then((r) => r.json()).then((j) => setMembers(j.members ?? []));
    fetch('/api/tags').then((r) => r.json()).then((j) => setTags(j.tags ?? [])).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, assigneeId, status, tag]);

  async function load() {
    setLoading(true);
    const params = new URLSearchParams({ from, to });
    if (assigneeId) params.set('assigneeId', assigneeId);
    if (status) params.set('status', status);
    if (tag) params.set('tag', tag);
    const res = await fetch(`/api/performance?${params}`);
    setLoading(false);
    if (!res.ok) return;
    const j = await res.json();
    setKpis(j.kpis);
    setAgents(j.agents);
    setTrend(j.trend);
  }

  function setPreset(days: number) {
    const t = new Date().toISOString().slice(0, 10);
    const f = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    setFrom(f);
    setTo(t);
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight">Team Performance</h1>
          <p className="text-sm text-muted-foreground">Response times, resolution rates, and per-agent breakdown.</p>
        </div>
        {loading && <span className="text-xs text-muted-foreground">Loading…</span>}
      </div>

      {/* Filters */}
      <div className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">From</label>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="!py-1 text-sm" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">To</label>
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="!py-1 text-sm" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Quick range</label>
          <div className="flex gap-1">
            {[7, 14, 30, 90].map((d) => (
              <button key={d} onClick={() => setPreset(d)} className="rounded border border-border px-2 py-1 text-xs hover:bg-elevated">
                {d}d
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Agent</label>
          <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className="!py-1 text-sm">
            <option value="">All agents</option>
            <option value="none">Unassigned</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="!py-1 text-sm">
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="WAITING_FOR_STUDENT">Waiting</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Tag</label>
          {tags.length > 0 ? (
            <select value={tag} onChange={(e) => setTag(e.target.value)} className="!py-1 text-sm">
              <option value="">All tags</option>
              {tags.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>
          ) : (
            <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="tag name" className="!py-1 text-sm w-28" />
          )}
        </div>
        <button onClick={() => { setAssigneeId(''); setStatus(''); setTag(''); setPreset(30); }}
          className="btn-secondary !px-3 !py-1 text-xs">
          Reset
        </button>
      </div>

      {/* KPI tiles */}
      {kpis && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiCard label="Total conversations" value={kpis.total} />
          <KpiCard label="Open" value={kpis.openCount} tone={kpis.openCount > 0 ? 'warn' : 'good'} />
          <KpiCard label="Resolved" value={kpis.resolvedCount} tone="good" sub={`${kpis.resolutionRate}% rate`} />
          <KpiCard label="Unread" value={kpis.unreadCount} tone={kpis.unreadCount > 0 ? 'warn' : 'neutral'} />
          <KpiCard label="Reply rate" value={`${kpis.replyRate}%`} tone={kpis.replyRate >= 80 ? 'good' : 'warn'} />
        </div>
      )}

      {kpis && (
        <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiCard label="Avg first response (FRT)" value={kpis.frtFormatted} sub="Inbound → first reply" tone="neutral" />
          <KpiCard label="Avg reply time (ART)" value={kpis.artFormatted} sub="Across all reply pairs" tone="neutral" />
          <KpiCard label="Avg resolution time" value={kpis.resolutionFormatted} sub="Created → resolved" tone="neutral" />
        </div>
      )}

      {/* Trend chart */}
      {trend.length > 0 && <MiniBarChart data={trend} />}

      {/* Per-agent table */}
      {agents.length > 0 && (
        <div className="mt-6 rounded-lg border bg-card">
          <div className="border-b border-border-subtle px-4 py-3">
            <h2 className="text-sm font-semibold">Agent breakdown</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left">Agent</th>
                  <th className="px-4 py-2 text-right">Assigned</th>
                  <th className="px-4 py-2 text-right">Responded</th>
                  <th className="px-4 py-2 text-right">Resolved</th>
                  <th className="px-4 py-2 text-right">Resolution %</th>
                  <th className="px-4 py-2 text-right">FRT</th>
                  <th className="px-4 py-2 text-right">ART</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a, i) => (
                  <tr key={a.userId} className={`border-t border-border-subtle ${i % 2 === 1 ? 'bg-muted/30' : ''}`}>
                    <td className="px-4 py-2">
                      <div className="font-medium">{a.name}</div>
                      <div className="text-xs text-muted-foreground">{a.email}</div>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{a.total}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{a.responded}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-success">{a.resolvedCount}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      <span className={a.resolutionRate >= 70 ? 'text-success' : a.resolutionRate >= 40 ? 'text-warning' : 'text-destructive'}>
                        {a.resolutionRate}%
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{a.frtFormatted}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{a.artFormatted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {kpis && agents.length === 0 && (
        <div className="mt-6 rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          No agent data for the selected filters.
          <Link href="/inbox" className="ml-2 underline">Go to inbox</Link>
        </div>
      )}
    </div>
  );
}
