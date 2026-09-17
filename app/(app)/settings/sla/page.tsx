'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import Link from 'next/link';

interface SlaRule {
  id: string;
  name: string;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  appliesTo: string;
  tagName: string | null;
  assigneeId: string | null;
  active: boolean;
  assignee: { id: string; name: string } | null;
}

function minutesToHM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

function hmToMinutes(h: number, m: number): number {
  return h * 60 + m;
}

const DEFAULT_FORM = {
  name: '',
  firstResponseH: 4,
  firstResponseM: 0,
  resolutionH: 24,
  resolutionM: 0,
  appliesTo: 'ALL',
  tagName: '',
  assigneeId: '',
  active: true,
};

export default function SlaPage() {
  const [rules, setRules] = useState<SlaRule[]>([]);
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  async function loadRules() {
    const res = await fetch('/api/sla-rules');
    const json = await res.json();
    setRules(json.rules ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadRules();
    fetch('/api/members')
      .then((r) => r.json())
      .then((j) => setMembers(j.members ?? []))
      .catch(() => undefined);
  }, []);

  function startEdit(rule: SlaRule) {
    setEditingId(rule.id);
    setForm({
      name: rule.name,
      firstResponseH: Math.floor(rule.firstResponseMinutes / 60),
      firstResponseM: rule.firstResponseMinutes % 60,
      resolutionH: Math.floor(rule.resolutionMinutes / 60),
      resolutionM: rule.resolutionMinutes % 60,
      appliesTo: rule.appliesTo,
      tagName: rule.tagName ?? '',
      assigneeId: rule.assigneeId ?? '',
      active: rule.active,
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm({ ...DEFAULT_FORM });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const body = {
        name: form.name,
        firstResponseMinutes: hmToMinutes(Number(form.firstResponseH), Number(form.firstResponseM)),
        resolutionMinutes: hmToMinutes(Number(form.resolutionH), Number(form.resolutionM)),
        appliesTo: form.appliesTo,
        tagName: form.appliesTo === 'TAG' ? form.tagName : null,
        assigneeId: form.appliesTo === 'ASSIGNEE' ? form.assigneeId : null,
        active: form.active,
      };

      let res: Response;
      if (editingId) {
        res = await fetch(`/api/sla-rules/${editingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        res = await fetch('/api/sla-rules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to save rule');
        return;
      }

      toast.success(editingId ? 'Rule updated' : 'Rule created');
      setEditingId(null);
      setForm({ ...DEFAULT_FORM });
      await loadRules();
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(rule: SlaRule) {
    const res = await fetch(`/api/sla-rules/${rule.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !rule.active }),
    });
    const json = await res.json();
    if (!res.ok) { toast.error(json.error ?? 'Failed to update'); return; }
    await loadRules();
  }

  async function deleteRule(id: string) {
    if (!confirm('Delete this SLA rule?')) return;
    const res = await fetch(`/api/sla-rules/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (!res.ok) { toast.error(json.error ?? 'Failed to delete'); return; }
    toast.success('Rule deleted');
    await loadRules();
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <Link href="/settings" className="text-sm text-muted-foreground hover:text-foreground">← Settings</Link>
        <h1 className="text-xl font-semibold">SLA Rules</h1>
      </div>
      <p className="mb-6 text-sm text-muted-foreground max-w-lg">
        Define response time targets. Conversations that breach a rule get a red SLA badge in the inbox.
      </p>

      {/* Rule list */}
      <section className="mb-8 max-w-2xl">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">No SLA rules yet. Create one below.</p>
        ) : (
          <div className="divide-y rounded-lg border bg-card">
            {rules.map((rule) => (
              <div key={rule.id} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`font-medium text-sm ${!rule.active ? 'text-muted-foreground' : ''}`}>{rule.name}</span>
                    {!rule.active && (
                      <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">inactive</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    First response: {minutesToHM(rule.firstResponseMinutes)} &nbsp;·&nbsp; Resolution: {minutesToHM(rule.resolutionMinutes)}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Applies to:{' '}
                    {rule.appliesTo === 'ALL' && 'All conversations'}
                    {rule.appliesTo === 'TAG' && `Tag: ${rule.tagName}`}
                    {rule.appliesTo === 'ASSIGNEE' && `Assignee: ${rule.assignee?.name ?? rule.assigneeId}`}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => toggleActive(rule)}
                    className="rounded border px-2 py-1 text-xs hover:bg-elevated"
                    title={rule.active ? 'Disable rule' : 'Enable rule'}
                  >
                    {rule.active ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => startEdit(rule)}
                    className="rounded border px-2 py-1 text-xs hover:bg-elevated"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => deleteRule(rule.id)}
                    className="rounded border px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Create / Edit form */}
      <section className="max-w-lg rounded-lg border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">{editingId ? 'Edit rule' : 'New SLA rule'}</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium">Rule name</label>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Standard response"
              required
              className="w-full rounded border bg-background px-3 py-1.5 text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium">First response target</label>
              <div className="flex items-center gap-1">
                <input
                  type="number" min={0} max={999}
                  value={form.firstResponseH}
                  onChange={(e) => setForm((f) => ({ ...f, firstResponseH: Number(e.target.value) }))}
                  className="w-16 rounded border bg-background px-2 py-1.5 text-sm"
                />
                <span className="text-xs text-muted-foreground">h</span>
                <input
                  type="number" min={0} max={59}
                  value={form.firstResponseM}
                  onChange={(e) => setForm((f) => ({ ...f, firstResponseM: Number(e.target.value) }))}
                  className="w-16 rounded border bg-background px-2 py-1.5 text-sm"
                />
                <span className="text-xs text-muted-foreground">m</span>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium">Resolution target</label>
              <div className="flex items-center gap-1">
                <input
                  type="number" min={0} max={9999}
                  value={form.resolutionH}
                  onChange={(e) => setForm((f) => ({ ...f, resolutionH: Number(e.target.value) }))}
                  className="w-16 rounded border bg-background px-2 py-1.5 text-sm"
                />
                <span className="text-xs text-muted-foreground">h</span>
                <input
                  type="number" min={0} max={59}
                  value={form.resolutionM}
                  onChange={(e) => setForm((f) => ({ ...f, resolutionM: Number(e.target.value) }))}
                  className="w-16 rounded border bg-background px-2 py-1.5 text-sm"
                />
                <span className="text-xs text-muted-foreground">m</span>
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium">Applies to</label>
            <select
              value={form.appliesTo}
              onChange={(e) => setForm((f) => ({ ...f, appliesTo: e.target.value }))}
              className="w-full rounded border bg-background px-2 py-1.5 text-sm"
            >
              <option value="ALL">All conversations</option>
              <option value="TAG">Specific tag</option>
              <option value="ASSIGNEE">Specific assignee</option>
            </select>
          </div>

          {form.appliesTo === 'TAG' && (
            <div>
              <label className="mb-1 block text-xs font-medium">Tag name</label>
              <input
                value={form.tagName}
                onChange={(e) => setForm((f) => ({ ...f, tagName: e.target.value }))}
                placeholder="e.g. urgent"
                required
                className="w-full rounded border bg-background px-3 py-1.5 text-sm"
              />
            </div>
          )}

          {form.appliesTo === 'ASSIGNEE' && (
            <div>
              <label className="mb-1 block text-xs font-medium">Assignee</label>
              <select
                value={form.assigneeId}
                onChange={(e) => setForm((f) => ({ ...f, assigneeId: e.target.value }))}
                required
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              >
                <option value="">Select assignee…</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="sla-active"
              checked={form.active}
              onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
              className="accent-primary"
            />
            <label htmlFor="sla-active" className="text-sm">Active</label>
          </div>

          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={saving} className="btn-primary text-sm px-4 py-1.5">
              {saving ? 'Saving…' : editingId ? 'Update rule' : 'Create rule'}
            </button>
            {editingId && (
              <button type="button" onClick={cancelEdit} className="rounded border px-4 py-1.5 text-sm hover:bg-elevated">
                Cancel
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
