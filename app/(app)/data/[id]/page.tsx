'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { DataGrid, type GridColumn, type GridRecord, type GridSort } from '@/components/data-grid/DataGrid';
import { ConditionBuilder, type Group } from '@/components/automation-builder/ConditionBuilder';

interface SavedView {
  id: string;
  name: string;
  filter: Group;
  sort: GridSort[] | null;
  groupBy: string | null;
}

interface DatasetDetail {
  dataset: { id: string; name: string; description: string | null };
  columns: GridColumn[];
  savedViews: SavedView[];
  records: GridRecord[];
  total: number;
  matched: number;
  page: number;
  pageSize: number;
  pageCount: number;
  groups: { value: string; count: number }[] | null;
  groupOf: string[] | null;
  viewId: string | null;
  truncated: boolean;
}

const SYSTEM_FIELDS: { key: string; label: string }[] = [
  { key: '__emailStatus', label: 'Email Status' },
  { key: '__replyReceived', label: 'Reply Received' },
  { key: '__unreadReply', label: 'Unread Reply' },
  { key: '__followUpRequired', label: 'Follow-up Required' },
  { key: '__lastEmailSentAt', label: 'Last Email Sent At' },
  { key: '__lastReplyAt', label: 'Last Reply At' },
  { key: '__createdAt', label: 'Created At' },
];

const EMPTY_FILTER: Group = { op: 'AND', rules: [] };

/** §12 spreadsheet page: search, filter, sort, group, saved views, column controls, bulk edit. */
export default function DatasetDetailPage() {
  const params = useParams<{ id: string }>();
  const [detail, setDetail] = useState<DatasetDetail | null>(null);
  const [loading, setLoading] = useState(true);

  // View state (what the server is asked for)
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Group>(EMPTY_FILTER);
  const [sort, setSort] = useState<GridSort[]>([]);
  const [groupBy, setGroupBy] = useState('');
  const [viewId, setViewId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [freezeFirst, setFreezeFirst] = useState(true);

  // UI state
  const [panel, setPanel] = useState<'filter' | 'columns' | 'bulk' | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkField, setBulkField] = useState('');
  const [bulkValue, setBulkValue] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (search.trim()) qs.set('search', search.trim());
    if (filter.rules.length > 0) qs.set('filter', JSON.stringify(filter));
    if (sort.length > 0) qs.set('sort', JSON.stringify(sort));
    if (groupBy) qs.set('groupBy', groupBy);
    if (viewId) qs.set('viewId', viewId);
    qs.set('page', String(page));
    qs.set('pageSize', String(pageSize));
    const res = await fetch(`/api/datasets/${params.id}?${qs.toString()}`);
    if (!res.ok) {
      toast.error('Failed to load dataset');
      setLoading(false);
      return;
    }
    setDetail(await res.json());
    setLoading(false);
  }, [params.id, search, filter, sort, groupBy, viewId, page, pageSize]);

  useEffect(() => {
    const t = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const columnOptions = useMemo(
    () => [...(detail?.columns ?? []).map((c) => ({ key: c.key, label: c.label })), ...SYSTEM_FIELDS],
    [detail?.columns]
  );
  const labelOf = (key: string) => columnOptions.find((c) => c.key === key)?.label ?? key;

  // ── view helpers ────────────────────────────────────────────────────
  function applySavedView(id: string) {
    const v = detail?.savedViews.find((x) => x.id === id);
    setViewId(id || null);
    setFilter(v?.filter ?? EMPTY_FILTER);
    setSort(v?.sort ?? []);
    setGroupBy(v?.groupBy ?? '');
    setPage(1);
    setSelected(new Set());
  }

  function clearView() {
    setViewId(null);
    setFilter(EMPTY_FILTER);
    setSort([]);
    setGroupBy('');
    setSearch('');
    setPage(1);
  }

  async function saveView(asNew: boolean) {
    const current = detail?.savedViews.find((v) => v.id === viewId);
    const name = asNew || !current ? prompt('View name', current ? `${current.name} copy` : 'My view') : current.name;
    if (!name) return;
    const body = { name, filter, sort: sort.length ? sort : null, groupBy: groupBy || null };
    const res = await fetch(asNew || !current ? `/api/datasets/${params.id}/views` : `/api/datasets/${params.id}/views/${current.id}`, {
      method: asNew || !current ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) return toast.error(json.error ?? 'Could not save the view');
    toast.success(asNew || !current ? `Saved view "${name}"` : `Updated view "${name}"`);
    setViewId(json.view.id);
    load();
  }

  async function deleteView() {
    const current = detail?.savedViews.find((v) => v.id === viewId);
    if (!current || !confirm(`Delete view "${current.name}"?`)) return;
    const res = await fetch(`/api/datasets/${params.id}/views/${current.id}`, { method: 'DELETE' });
    if (!res.ok) return toast.error('Could not delete the view');
    clearView();
    load();
  }

  function toggleSort(key: string) {
    setPage(1);
    setSort((prev) => {
      const existing = prev.find((s) => s.key === key);
      if (!existing) return [{ key, dir: 'asc' as const }, ...prev].slice(0, 3);
      if (existing.dir === 'asc') return prev.map((s) => (s.key === key ? { key, dir: 'desc' as const } : s));
      return prev.filter((s) => s.key !== key);
    });
  }

  // ── row / cell mutations ────────────────────────────────────────────
  async function handleCellCommit(recordId: string, key: string, value: string) {
    const res = await fetch(`/api/records/${recordId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { [key]: value } }),
    });
    if (!res.ok) return toast.error('Failed to save cell');
    load();
  }

  async function handleDeleteRow(recordId: string) {
    const res = await fetch(`/api/records/${recordId}`, { method: 'DELETE' });
    if (!res.ok) return toast.error('Failed to delete row');
    setSelected((s) => {
      const n = new Set(s);
      n.delete(recordId);
      return n;
    });
    load();
  }

  async function handleDuplicateRow(recordId: string) {
    const source = detail?.records.find((r) => r.id === recordId);
    if (!source) return;
    const res = await fetch(`/api/datasets/${params.id}/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: source.data }),
    });
    if (!res.ok) return toast.error('Failed to duplicate row');
    toast.success('Row duplicated');
    load();
  }

  async function handleAddRow() {
    const res = await fetch(`/api/datasets/${params.id}/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });
    if (!res.ok) return toast.error('Failed to add row');
    load();
  }

  // ── columns ─────────────────────────────────────────────────────────
  async function patchColumn(columnId: string, patch: Record<string, unknown>, okMessage?: string) {
    const res = await fetch(`/api/datasets/${params.id}/columns/${columnId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return toast.error(json.error ?? 'Failed to update column');
    if (okMessage) toast.success(okMessage);
    load();
    return json;
  }

  async function handleColumnTypeChange(columnId: string, type: string) {
    const json = await patchColumn(columnId, { type });
    if (json) toast.success(json.contactsLinked ? `Column set to ${type} — ${json.contactsLinked} contact(s) linked.` : `Column set to ${type}.`);
  }

  async function moveColumn(columnId: string, delta: -1 | 1) {
    const cols = detail?.columns ?? [];
    const idx = cols.findIndex((c) => c.id === columnId);
    const to = idx + delta;
    if (idx < 0 || to < 0 || to >= cols.length) return;
    const order = cols.map((c) => c.id);
    [order[idx], order[to]] = [order[to]!, order[idx]!];
    const res = await fetch(`/api/datasets/${params.id}/columns`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    });
    if (!res.ok) return toast.error('Failed to reorder columns');
    load();
  }

  async function renameColumn(columnId: string, current: string) {
    const label = prompt('Column name', current);
    if (!label || label === current) return;
    await patchColumn(columnId, { label }, 'Column renamed');
  }

  async function deleteColumn(columnId: string, label: string) {
    if (!confirm(`Delete column "${label}"? Values in this column are removed from every record.`)) return;
    const res = await fetch(`/api/datasets/${params.id}/columns/${columnId}`, { method: 'DELETE' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return toast.error(json.error ?? 'Failed to delete column');
    toast.success('Column deleted');
    load();
  }

  async function handleAddColumn() {
    const label = prompt('Column name');
    if (!label) return;
    const key = label.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const res = await fetch(`/api/datasets/${params.id}/columns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: /^[a-zA-Z]/.test(key) ? key : `f_${key}`, label, type: 'TEXT' }),
    });
    if (!res.ok) {
      const json = await res.json();
      return toast.error(json.error ?? 'Failed to add column');
    }
    load();
  }

  // ── bulk ────────────────────────────────────────────────────────────
  async function bulk(action: 'update' | 'delete') {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (action === 'update' && !bulkField) return toast.error('Choose a column to set.');
    if (action === 'delete' && !confirm(`Delete ${ids.length} selected record(s)? This cannot be undone.`)) return;
    if (action === 'update' && !confirm(`Set "${labelOf(bulkField)}" to "${bulkValue}" on ${ids.length} record(s)? Automations that trigger on record updates will evaluate.`)) return;
    setBusy(true);
    const res = await fetch(`/api/datasets/${params.id}/records/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action === 'update' ? { action, recordIds: ids, data: { [bulkField]: bulkValue } } : { action, recordIds: ids }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return toast.error(json.error ?? 'Bulk action failed');
    if (action === 'delete') toast.success(`Deleted ${json.deleted} record(s)`);
    else toast.success(`Updated ${json.updated} record(s)${json.unchanged ? `, ${json.unchanged} unchanged` : ''}${json.automationsEvaluated ? ` · ${json.automationsEvaluated} automation evaluation(s)` : ''}`);
    setSelected(new Set());
    setPanel(null);
    load();
  }

  if (loading && !detail) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!detail) return <div className="p-6 text-sm text-muted-foreground">Dataset not found.</div>;

  const activeView = detail.savedViews.find((v) => v.id === viewId) ?? null;
  const filterCount = filter.rules.length;
  const hiddenCount = detail.columns.filter((c) => c.hidden).length;

  return (
    <div className="flex h-full min-h-[calc(100dvh-3.5rem)] lg:min-h-0 flex-col p-6">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-bold tracking-tight">{detail.dataset.name}</h1>
          <p className="text-sm text-muted-foreground">
            {detail.matched === detail.total ? `${detail.total} records` : `${detail.matched} of ${detail.total} records`} · {detail.columns.length} columns
            {detail.truncated && <span className="ml-2 text-warning">Showing the first 5,000 records for filtering.</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleAddColumn} className="btn-secondary">+ Column</button>
          <button onClick={handleAddRow} className="btn-secondary">+ Row</button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="Search all columns…"
          className="w-56 !py-1.5 text-xs"
        />

        <select
          value={viewId ?? ''}
          onChange={(e) => applySavedView(e.target.value)}
          className="!w-auto !py-1.5 text-xs"
          title="Saved views"
        >
          <option value="">All records</option>
          {detail.savedViews.map((v) => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
        </select>

        <button onClick={() => setPanel(panel === 'filter' ? null : 'filter')} className={`btn-secondary !py-1.5 text-[11px] ${filterCount ? '!border-primary !text-primary' : ''}`}>
          Filter{filterCount ? ` (${filterCount})` : ''}
        </button>

        <select
          value={groupBy}
          onChange={(e) => {
            setGroupBy(e.target.value);
            setPage(1);
          }}
          className={`!w-auto !py-1.5 text-xs ${groupBy ? '!border-primary' : ''}`}
          title="Group by"
        >
          <option value="">No grouping</option>
          {columnOptions.map((c) => (
            <option key={c.key} value={c.key}>Group: {c.label}</option>
          ))}
        </select>

        {sort.length > 0 && (
          <span className="flex items-center gap-1 rounded-full border border-border px-2 py-1">
            Sort: {sort.map((s) => `${labelOf(s.key)} ${s.dir === 'asc' ? '↑' : '↓'}`).join(', ')}
            <button onClick={() => setSort([])} className="ml-1 text-muted-foreground hover:text-foreground" title="Clear sort">✕</button>
          </span>
        )}

        <button onClick={() => setPanel(panel === 'columns' ? null : 'columns')} className="btn-secondary !py-1.5 text-[11px]">
          Columns{hiddenCount ? ` (${hiddenCount} hidden)` : ''}
        </button>

        <label className="flex items-center gap-1 text-muted-foreground">
          <input type="checkbox" checked={freezeFirst} onChange={(e) => setFreezeFirst(e.target.checked)} /> Freeze first column
        </label>

        <span className="ml-auto flex items-center gap-1">
          {(filterCount > 0 || sort.length > 0 || groupBy || viewId) && (
            <>
              <button onClick={() => saveView(false)} className="btn-primary !py-1.5 text-[11px]">
                {activeView ? 'Update view' : 'Save view'}
              </button>
              {activeView && (
                <>
                  <button onClick={() => saveView(true)} className="btn-secondary !py-1.5 text-[11px]">Save as new</button>
                  <button onClick={deleteView} className="text-muted-foreground hover:text-destructive" title="Delete view">🗑</button>
                </>
              )}
              <button onClick={clearView} className="ml-1 text-muted-foreground hover:text-foreground">Clear</button>
            </>
          )}
        </span>
      </div>

      {panel === 'filter' && (
        <div className="mb-3 max-w-3xl">
          <ConditionBuilder
            group={filter}
            columns={columnOptions}
            label="Show records where"
            onChange={(g) => {
              setFilter(g);
              setPage(1);
            }}
          />
        </div>
      )}

      {panel === 'columns' && (
        <div className="mb-3 max-w-3xl rounded-md border p-3">
          <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Columns — show, hide, rename, reorder</div>
          <ul className="grid gap-1 sm:grid-cols-2">
            {detail.columns.map((c, i) => (
              <li key={c.id} className="flex items-center gap-2 rounded-md border border-border-subtle px-2 py-1 text-xs">
                <input type="checkbox" checked={!c.hidden} onChange={() => patchColumn(c.id, { hidden: !c.hidden })} title={c.hidden ? 'Show' : 'Hide'} />
                <span className={`flex-1 truncate ${c.hidden ? 'text-faint line-through' : ''}`}>{c.label}</span>
                <span className="text-[10px] text-faint">{c.type}</span>
                <button onClick={() => moveColumn(c.id, -1)} disabled={i === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-30" title="Move left">←</button>
                <button onClick={() => moveColumn(c.id, 1)} disabled={i === detail.columns.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-30" title="Move right">→</button>
                <button onClick={() => renameColumn(c.id, c.label)} className="text-muted-foreground hover:text-foreground" title="Rename">✎</button>
                <button onClick={() => deleteColumn(c.id, c.label)} className="text-muted-foreground hover:text-destructive" title="Delete column">✕</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs">
          <span className="font-semibold">{selected.size} selected</span>
          <select value={bulkField} onChange={(e) => setBulkField(e.target.value)} className="!w-auto !py-1 text-xs">
            <option value="">Set column…</option>
            {detail.columns.map((c) => (
              <option key={c.id} value={c.key}>{c.label}</option>
            ))}
          </select>
          <input value={bulkValue} onChange={(e) => setBulkValue(e.target.value)} placeholder="to value" className="w-40 !py-1 text-xs" />
          <button onClick={() => bulk('update')} disabled={busy || !bulkField} className="btn-primary !py-1 text-[11px]">
            {busy ? 'Working…' : 'Apply to selected'}
          </button>
          <button onClick={() => bulk('delete')} disabled={busy} className="btn-secondary !py-1 text-[11px] !text-primary">Delete selected</button>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-muted-foreground hover:text-foreground">Clear selection</button>
        </div>
      )}

      {detail.groups && (
        <div className="mb-2 flex flex-wrap gap-1 text-[11px]">
          {detail.groups.map((g) => (
            <span key={g.value} className="badge badge-neutral">{g.value === '' ? '(empty)' : g.value}: {g.count}</span>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <DataGrid
          columns={detail.columns}
          records={detail.records}
          groupOf={detail.groupOf}
          sort={sort}
          selected={selected}
          freezeFirst={freezeFirst}
          rowOffset={(detail.page - 1) * detail.pageSize}
          onCellCommit={async (r, k, v) => {
            await handleCellCommit(r, k, v);
          }}
          onDeleteRow={async (r) => {
            await handleDeleteRow(r);
          }}
          onDuplicateRow={async (r) => {
            await handleDuplicateRow(r);
          }}
          onColumnTypeChange={handleColumnTypeChange}
          onColumnResize={(columnId, width) => patchColumn(columnId, { width })}
          onSortChange={toggleSort}
          onSelectionChange={setSelected}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Double-click a cell to edit · click a header to sort · drag a header edge to resize.</span>
        <span className="flex items-center gap-2">
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} className="!w-auto !py-1 text-xs">
            {[25, 50, 100, 200].map((n) => (
              <option key={n} value={n}>{n} / page</option>
            ))}
          </select>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={detail.page <= 1} className="btn-secondary !py-1 text-[11px]">‹ Prev</button>
          <span>Page {detail.page} of {detail.pageCount}</span>
          <button onClick={() => setPage((p) => Math.min(detail.pageCount, p + 1))} disabled={detail.page >= detail.pageCount} className="btn-secondary !py-1 text-[11px]">Next ›</button>
        </span>
      </div>
    </div>
  );
}
