'use client';

import { useEffect, useMemo, useState, Fragment } from 'react';
import { ListPager, useClientPaging } from '@/components/ui/ListPager';
import Link from 'next/link';
import { Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { LoadGate } from '@/components/loading/LoadingScreen';
import { SortTh } from '@/components/ui/SortTh';
import { sortRows, nextSort, type SortDir } from '@/lib/ui/sort';

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
  _count?: { documents: number };
  tracking?: { opens: number; clicks: number; totalOpens?: number; totalClicks?: number; sent?: number; openRate: number | null; clickRate: number | null };
}

type SortKey = 'name' | 'status' | 'dataset' | 'template' | 'sent' | 'opens' | 'totalOpens' | 'clicks' | 'createdAt';
const sortValue = (c: CampaignRow, k: SortKey): unknown => {
  switch (k) {
    case 'name': return c.name;
    case 'status': return c.status;
    case 'dataset': return c.dataset.name;
    case 'template': return c.template.name;
    case 'sent': return c.batches.reduce((s, b) => s + b.sentCount, 0);
    case 'opens': return c.tracking?.opens ?? 0;
    case 'totalOpens': return c.tracking?.totalOpens ?? c.tracking?.opens ?? 0;
    case 'clicks': return c.tracking?.clicks ?? 0;
    case 'createdAt': return c.createdAt;
  }
};

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
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'createdAt', dir: 'desc' });
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = campaigns.filter((c) => {
      if (statusFilter !== 'ALL' && c.status !== statusFilter) return false;
      if (!needle) return true;
      return [c.name, c.createdBy.name, c.createdBy.email, c.dataset.name, c.template.name, c.status.replace(/_/g, ' ')].some((v) => v.toLowerCase().includes(needle));
    });
    return sortRows(filtered, (c) => sortValue(c, sort.key), sort.dir);
  }, [campaigns, search, statusFilter, sort]);
  const statusCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of campaigns) m.set(c.status, (m.get(c.status) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [campaigns]);
  const onSort = (key: SortKey, first: SortDir) => setSort((cur) => nextSort(cur, key, first));
  const paged = useClientPaging(shown, 25);
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [creating, setCreating] = useState(false);
  const [documents, setDocuments] = useState<{ id: string; name: string; fieldCount: number }[]>([]);
  const [form, setForm] = useState<{ name: string; datasetId: string; templateId: string; documentTemplateIds: string[] }>({
    name: '',
    datasetId: '',
    templateId: '',
    documentTemplateIds: [],
  });
  const [showForm, setShowForm] = useState(false);
  // Inline edit state for DRAFT campaigns
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ datasetId: string; templateId: string }>({ datasetId: '', templateId: '' });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const [c, d, t, docs] = await Promise.all([
      fetch('/api/campaigns').then((r) => r.json()),
      fetch('/api/datasets').then((r) => r.json()),
      fetch('/api/templates').then((r) => r.json()),
      fetch('/api/documents')
        .then((r) => r.json())
        .catch(() => ({ documents: [] })),
    ]);
    setCampaigns(c.campaigns ?? []);
    setDatasets(d.datasets ?? []);
    setTemplates(t.templates ?? []);
    setDocuments(docs.documents ?? []);
    setLoading(false);
    setLoadedOnce(true);
  }

  useEffect(() => {
    load();
  }, []);

  function startEdit(c: CampaignRow) {
    setEditingId(c.id);
    setEditForm({ datasetId: c.dataset.id, templateId: c.template.id });
  }

  async function saveEdit(campaignId: string) {
    setSaving(true);
    const res = await fetch(`/api/campaigns/${campaignId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editForm),
    });
    setSaving(false);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Failed to update campaign');
      return;
    }
    setEditingId(null);
    load();
  }

  async function deleteCampaign(campaignId: string, campaignName: string) {
    if (!confirm(`Delete "${campaignName}"? This cannot be undone.`)) return;
    setDeleting(campaignId);
    const res = await fetch(`/api/campaigns/${campaignId}`, { method: 'DELETE' });
    setDeleting(null);
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Failed to delete campaign');
      return;
    }
    if (json.cancelledInsteadOfDeleted) {
      toast.info(json.message);
    } else {
      toast.success(`"${campaignName}" deleted`);
    }
    load();
  }

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
    <LoadGate loading={!loadedOnce}>
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight">Campaigns</h1>
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
          <div className="mt-3">
            <div className="mb-1 text-xs font-medium">
              Personalised PDFs <span className="font-normal text-muted-foreground">(optional)</span>
            </div>
            {documents.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                None in the library yet.{' '}
                <Link href="/documents/library" className="text-primary hover:underline">
                  Upload an agreement or form
                </Link>{' '}
                to attach a filled copy to every email.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {documents.map((doc) => {
                  const on = form.documentTemplateIds.includes(doc.id);
                  return (
                    <label
                      key={doc.id}
                      className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${on ? 'border-primary bg-primary/10' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setForm({
                            ...form,
                            documentTemplateIds: on ? form.documentTemplateIds.filter((x) => x !== doc.id) : [...form.documentTemplateIds, doc.id],
                          })
                        }
                      />
                      📎 {doc.name} <span className="text-muted-foreground">({doc.fieldCount} fields)</span>
                    </label>
                  );
                })}
              </div>
            )}
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
        <>
        <div className="mb-3 flex flex-wrap items-center gap-2" data-campaign-filters>
          <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search campaign, person, dataset, template…"
              aria-label="Search campaigns"
              className="w-full rounded-md border bg-card py-1.5 pl-8 pr-8 text-sm"
            />
            {search && (
              <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="absolute right-2 top-1.5 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
            {[['ALL', campaigns.length] as [string, number], ...statusCounts].map(([s, n]) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                aria-pressed={statusFilter === s}
                className={`rounded-full border px-2.5 py-0.5 text-xs ${statusFilter === s ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-elevated'}`}
              >
                {s === 'ALL' ? 'All' : s.replace(/_/g, ' ').toLowerCase()} <span className="tabular-nums opacity-70">{n}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <SortTh label="Campaign" k="name" sort={sort} onSort={onSort} />
                <SortTh label="Status" k="status" sort={sort} onSort={onSort} />
                <SortTh label="Dataset" k="dataset" sort={sort} onSort={onSort} />
                <SortTh label="Template" k="template" sort={sort} onSort={onSort} />
                <SortTh label="Progress" k="sent" sort={sort} onSort={onSort} first="desc" />
                <SortTh label="Unique opens" k="opens" sort={sort} onSort={onSort} first="desc" align="right" />
                <SortTh label="Total opens" k="totalOpens" sort={sort} onSort={onSort} first="desc" align="right" />
                <SortTh label="Clicks" k="clicks" sort={sort} onSort={onSort} first="desc" align="right" />
                <SortTh label="Created" k="createdAt" sort={sort} onSort={onSort} first="desc" />
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No campaign matches{search ? <> “{search}”</> : ''}. <button type="button" className="text-primary hover:underline" onClick={() => { setSearch(''); setStatusFilter('ALL'); }}>Clear filters</button>
                </td></tr>
              )}
              {paged.rows.map((c) => {
                const batch = c.batches[0];
                const isDraft = c.status === 'DRAFT';
                const isEditingThis = editingId === c.id;
                return (
                  <Fragment key={c.id}>
                    <tr className={`border-t hover:bg-elevated/60 ${isEditingThis ? 'bg-elevated/40' : ''}`}>
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
                        {c._count?.documents ? (
                          <span className="ml-1 text-xs text-muted-foreground" title="Personalised PDFs attached">
                            📎 {c._count.documents}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {batch ? `${batch.sentCount} sent · ${batch.failedCount} failed of ${batch.total}` : '—'}
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-muted-foreground">
                        {c.tracking && c.tracking.opens > 0 ? (
                          <span title={`${c.tracking.openRate ?? 0}% open rate`}>
                            {c.tracking.opens}
                            {c.tracking.openRate !== null && <span className="ml-1 text-faint">{c.tracking.openRate}%</span>}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-2 text-right text-xs tabular-nums text-muted-foreground" title="Every open, repeats included">
                        {(c.tracking?.totalOpens ?? 0) > 0 ? c.tracking!.totalOpens : '—'}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(c.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-muted-foreground">
                        {c.tracking && c.tracking.clicks > 0 ? (
                          <span title={`${c.tracking.clickRate ?? 0}% click rate`}>
                            {c.tracking.clicks}
                            {c.tracking.clickRate !== null && <span className="ml-1 text-faint">{c.tracking.clickRate}%</span>}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-2">
                        {isDraft && (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => isEditingThis ? setEditingId(null) : startEdit(c)}
                              className="rounded border px-2 py-0.5 text-xs hover:bg-elevated"
                              title="Change dataset or template"
                            >
                              {isEditingThis ? 'Cancel' : 'Edit'}
                            </button>
                            <button
                              onClick={() => deleteCampaign(c.id, c.name)}
                              disabled={deleting === c.id}
                              className="rounded border border-destructive/40 px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10"
                              title="Delete this draft"
                            >
                              {deleting === c.id ? '…' : 'Delete'}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                    {isEditingThis && (
                      <tr key={`${c.id}-edit`} className="border-t bg-elevated/30">
                        <td colSpan={10} className="px-4 py-3">
                          <div className="flex flex-wrap items-end gap-3">
                            <div>
                              <label className="mb-1 block text-xs font-medium">Dataset</label>
                              <select
                                value={editForm.datasetId}
                                onChange={(e) => setEditForm({ ...editForm, datasetId: e.target.value })}
                                className="rounded-md border px-2 py-1.5 text-sm"
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
                                value={editForm.templateId}
                                onChange={(e) => setEditForm({ ...editForm, templateId: e.target.value })}
                                className="rounded-md border px-2 py-1.5 text-sm"
                              >
                                <option value="">Select…</option>
                                {templates.map((t) => (
                                  <option key={t.id} value={t.id}>{t.name}</option>
                                ))}
                              </select>
                            </div>
                            <button
                              onClick={() => saveEdit(c.id)}
                              disabled={saving || (!editForm.datasetId && !editForm.templateId)}
                              className="btn-primary"
                            >
                              {saving ? 'Saving…' : 'Save changes'}
                            </button>
                            <p className="text-xs text-muted-foreground">
                              Changing the template pins its latest saved version to this campaign.
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <ListPager {...paged.pager} noun="campaigns" className="border-t px-3" />
        </div>
        </>
      )}
    </div>
    </LoadGate>
  );
}
