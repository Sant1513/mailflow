'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { DataGrid, type GridColumn, type GridRecord } from '@/components/data-grid/DataGrid';

interface DatasetDetail {
  dataset: { id: string; name: string; description: string | null };
  columns: GridColumn[];
  records: GridRecord[];
  total: number;
}

export default function DatasetDetailPage() {
  const params = useParams<{ id: string }>();
  const [detail, setDetail] = useState<DatasetDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/datasets/${params.id}`);
    if (!res.ok) {
      toast.error('Failed to load dataset');
      setLoading(false);
      return;
    }
    const json = await res.json();
    setDetail(json);
    setLoading(false);
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCellCommit(recordId: string, key: string, value: string) {
    const res = await fetch(`/api/records/${recordId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { [key]: value } }),
    });
    if (!res.ok) {
      toast.error('Failed to save cell');
      return;
    }
    load();
  }

  async function handleDeleteRow(recordId: string) {
    const res = await fetch(`/api/records/${recordId}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Failed to delete row');
      return;
    }
    load();
  }

  async function handleAddRow() {
    const res = await fetch(`/api/datasets/${params.id}/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });
    if (!res.ok) {
      toast.error('Failed to add row');
      return;
    }
    load();
  }

  async function handleColumnTypeChange(columnId: string, type: string) {
    const res = await fetch(`/api/datasets/${params.id}/columns/${columnId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Failed to change column type');
      return;
    }
    toast.success(
      json.contactsLinked
        ? `Column set to ${type} — ${json.contactsLinked} contact(s) linked.`
        : `Column set to ${type}.`
    );
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
      toast.error(json.error ?? 'Failed to add column');
      return;
    }
    load();
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!detail) return <div className="p-6 text-sm text-muted-foreground">Dataset not found.</div>;

  return (
    <div className="flex h-screen flex-col p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{detail.dataset.name}</h1>
          <p className="text-sm text-muted-foreground">{detail.total} records · {detail.columns.length} columns</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleAddColumn} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
            + Column
          </button>
          <button onClick={handleAddRow} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
            + Row
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <DataGrid
          columns={detail.columns}
          records={detail.records}
          onCellCommit={handleCellCommit}
          onDeleteRow={handleDeleteRow}
          onColumnTypeChange={handleColumnTypeChange}
        />
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Double-click a cell to edit. Saved views, filtering, and bulk edit are tracked in
        PHASE_STATUS.md as Phase 1 follow-ups.
      </p>
    </div>
  );
}
