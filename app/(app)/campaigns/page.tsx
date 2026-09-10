'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  dataset: { id: string; name: string; _count: { records: number } };
  template: { id: string; name: string };
  templateVersion: { version: number };
  createdBy: { name: string; email: string };
  batches: { id: string; label: string; status: string; sentCount: number; failedCount: number; total: number }[];
}

const STATUS_STYLES: Record<string, string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  PENDING_APPROVAL: 'bg-warning/15 text-warning',
  APPROVED: 'bg-info/15 text-info',
  SCHEDULED: 'bg-info/15 text-info',
  RUNNING: 'bg-info/15 text-info',
  PAUSED: 'bg-warning/15 text-warning',
  COMPLETED: 'bg-success/15 text-success',
  PARTIALLY_FAILED: 'bg-warning/15 text-warning',
  CANCELLED: 'bg-muted text-muted-foreground',
  REJECTED: 'bg-destructive/15 text-primary',
};

export default function CampaignsPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', datasetId: '', templateId: '' });
  const [showForm, setShowForm] = useState(false);

  async function load() {
    setLoading(true);
    const [c, d, t] = await Promise.all([
      fetch('/api/campaigns').then((r) => r.json()),
      fetch('/api/datasets').then((r) => r.json()),
      fetch('/api/templates').then((r) => r.json()),
    ]);
    setCampaigns(c.campaigns ?? []);
    setDatasets(d.datasets ?? []);
    setTemplates(t.templates ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function create() {
    if (!form.name || !form.datasetId || !form.templateId) {
      toast.error('Name, dataset and template are all required');
      return;
    }
    setCreating(true);
    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    setCreating(false);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Failed to create campaign');
      return;
    }
    router.push(`/campaigns/${json.campaign.id}`);
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Campaigns</h1>
          <p className="text-sm text-muted-foreground">
            Simulate, get approval, then send from your connected Gmail account.
          </p>
        </div>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="btn-primary"
        >
          New campaign
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-lg border bg-card p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium">Campaign name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="RPG Clearance Reminder"
                className="w-full rounded-md border px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Dataset</label>
              <select
                value={form.datasetId}
                onChange={(e) => setForm({ ...form, datasetId: e.target.value })}
                className="w-full rounded-md border px-2 py-1.5 text-sm"
              >
                <option value="">Select…</option>
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Template</label>
              <select
                value={form.templateId}
                onChange={(e) => setForm({ ...form, templateId: e.target.value })}
                className="w-full rounded-md border px-2 py-1.5 text-sm"
              >
                <option value="">Select…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            The template&apos;s current version is pinned to this campaign — later template edits will
            not change what this campaign sends.
          </p>
          <div className="mt-3 flex gap-2">
            <button onClick={() => setShowForm(false)} className="btn-secondary">
              Cancel
            </button>
            <button
              onClick={create}
              disabled={creating}
              className="btn-primary"
            >
              {creating ? 'Creating…' : 'Create campaign'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : campaigns.length === 0 ? (
        <div className="mt-16 text-center text-sm text-muted-foreground">
          No campaigns yet. Create one to get started.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Campaign</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Dataset</th>
                <th className="px-4 py-2">Template</th>
                <th className="px-4 py-2">Progress</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const batch = c.batches[0];
                return (
                  <tr key={c.id} className="border-t hover:bg-elevated/60">
                    <td className="px-4 py-2">
                      <Link href={`/campaigns/${c.id}`} className="font-medium text-primary hover:underline">
                        {c.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">by {c.createdBy.name}</div>
                    </td>
                    <td className="px-4 py-2">
                      <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLES[c.status] ?? 'bg-muted'}`}>
                        {c.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      {c.dataset.name}
                      <span className="ml-1 text-xs text-muted-foreground">({c.dataset._count.records})</span>
                    </td>
                    <td className="px-4 py-2">
                      {c.template.name} <span className="text-xs text-muted-foreground">v{c.templateVersion.version}</span>
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {batch ? `${batch.sentCount} sent · ${batch.failedCount} failed of ${batch.total}` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
