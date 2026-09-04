'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

const ROLES = ['SUPER_ADMIN', 'ADMIN', 'OPERATOR', 'VIEWER'];

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  workspace: { id: string; name: string; contacts: number; campaigns: number } | null;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => {
    load();
  }, []);

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
    <div className="p-6">
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
  );
}
