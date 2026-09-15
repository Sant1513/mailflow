'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

const ROLES = ['SUPER_ADMIN', 'ADMIN', 'OPERATOR', 'VIEWER'];
const DAY_PRESETS = [7, 30, 90];

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  slackUserId: string | null;
  workspace: { id: string; name: string; contacts: number; campaigns: number } | null;
}

interface ResponseTimeRow {
  userId: string;
  userName: string | null;
  userEmail: string;
  frtMinutes: number | null;
  artMinutes: number | null;
  respondedConversations: number;
  totalAssignedConversations: number;
}

function fmtDuration(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [rtRows, setRtRows] = useState<ResponseTimeRow[]>([]);
  const [rtLoading, setRtLoading] = useState(true);
  const [rtDays, setRtDays] = useState(30);

  async function load() {
    setLoading(true);
    const res = await fetch('/api/admin/users');
    if (res.status === 403) {
      toast.error('Super admin only');
      setLoading(false);
      return;
    }
    const json = await res.json();
    setUsers(json.users ?? []);
    setLoading(false);
  }

  async function loadRt(days: number) {
    setRtLoading(true);
    const res = await fetch(`/api/admin/response-times?days=${days}`);
    if (res.ok) {
      const json = await res.json();
      setRtRows(json.rows ?? []);
    }
    setRtLoading(false);
  }

  useEffect(() => { load(); }, []);
  useEffect(() => { loadRt(rtDays); }, [rtDays]);

  async function changeRole(id: string, role: string) {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      const json = await res.json();
      toast.error(json.error ?? 'Failed to change role');
      return;
    }
    toast.success('Role updated');
    load();
  }

  async function setSlackId(id: string, current: string | null) {
    const value = prompt('Slack member ID (U…); leave empty to clear', current ?? '');
    if (value === null) return;
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slackUserId: value.trim().toUpperCase() }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json.error ?? json.issues?.[0]?.message ?? 'Failed to update Slack ID');
      return;
    }
    toast.success(value.trim() ? 'Slack ID saved' : 'Slack ID cleared');
    load();
  }

  async function toggleStatus(id: string, current: string) {
    const status = current === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      toast.error('Failed to update status');
      return;
    }
    load();
  }

  return (
    <div className="p-6 space-y-8">
      {/* User management table */}
      <div>
        <h1 className="mb-1 text-xl font-semibold">Users</h1>
        <p className="mb-4 text-sm text-muted-foreground">Organization-wide user &amp; role management.</p>

        {loading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="overflow-hidden rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Email</th>
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2">Workspace</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Slack</th>
                  <th className="px-4 py-2">Last Login</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t">
                    <td className="px-4 py-2">{u.name}</td>
                    <td className="px-4 py-2">{u.email}</td>
                    <td className="px-4 py-2">
                      <select
                        value={u.role}
                        onChange={(e) => changeRole(u.id, e.target.value)}
                        className="rounded border px-1.5 py-0.5 text-xs"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      {u.workspace ? `${u.workspace.contacts} contacts · ${u.workspace.campaigns} campaigns` : '—'}
                    </td>
                    <td className="px-4 py-2">{u.status}</td>
                    <td className="px-4 py-2">
                      <button onClick={() => setSlackId(u.id, u.slackUserId)} className="font-mono text-xs text-muted-foreground hover:text-primary" title="Set Slack member ID">
                        {u.slackUserId ?? '— set'}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}
                    </td>
                    <td className="px-4 py-2">
                      <button
                        onClick={() => toggleStatus(u.id, u.status)}
                        className="text-xs text-muted-foreground hover:text-destructive"
                      >
                        {u.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Per-user response times */}
      <div>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Response Times by User</h2>
            <p className="text-sm text-muted-foreground">
              FRT and ART for conversations assigned to each user. Excludes auto-replies, bounces, and OOO messages.
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
            {DAY_PRESETS.map((d) => (
              <button
                key={d}
                onClick={() => setRtDays(d)}
                className={`rounded-md px-3 py-1 text-sm font-medium transition ${
                  rtDays === d
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-elevated hover:text-foreground'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        {rtLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : rtRows.length === 0 ? (
          <div className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
            No assigned conversations in the last {rtDays} days.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">User</th>
                  <th className="px-4 py-2 text-right">Assigned</th>
                  <th className="px-4 py-2 text-right">Responded</th>
                  <th className="px-4 py-2 text-right">FRT</th>
                  <th className="px-4 py-2 text-right">ART</th>
                </tr>
              </thead>
              <tbody>
                {rtRows
                  .sort((a, b) => (a.frtMinutes ?? Infinity) - (b.frtMinutes ?? Infinity))
                  .map((r) => (
                    <tr key={r.userId} className="border-t">
                      <td className="px-4 py-2">
                        <div className="font-medium">{r.userName ?? '—'}</div>
                        <div className="text-xs text-faint">{r.userEmail}</div>
                      </td>
                      <td className="px-4 py-2 text-right">{r.totalAssignedConversations}</td>
                      <td className="px-4 py-2 text-right">
                        {r.respondedConversations}
                        {r.totalAssignedConversations > 0 && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({Math.round((r.respondedConversations / r.totalAssignedConversations) * 100)}%)
                          </span>
                        )}
                      </td>
                      <td className={`px-4 py-2 text-right font-medium ${r.frtMinutes !== null && r.frtMinutes > 240 ? 'text-warning' : 'text-primary'}`}>
                        {fmtDuration(r.frtMinutes)}
                      </td>
                      <td className={`px-4 py-2 text-right font-medium ${r.artMinutes !== null && r.artMinutes > 480 ? 'text-warning' : 'text-foreground'}`}>
                        {fmtDuration(r.artMinutes)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <div className="border-t border-border px-4 py-2 text-[11px] text-faint">
              FRT = first response time (time from conversation start to first outbound reply). ART = average response time across all inbound→outbound pairs. Sorted by FRT ascending.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
