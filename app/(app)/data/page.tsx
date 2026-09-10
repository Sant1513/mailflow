'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { ImportDialog } from '@/components/data-grid/ImportDialog';

interface DatasetRow {
  id: string;
  name: string;
  description: string | null;
  updatedAt: string;
  _count: { records: number; columns: number };
}

export default function DataPage() {
  const searchParams = useSearchParams();
  const workspaceId = searchParams.get('workspaceId');
  const [datasets, setDatasets] = useState<DatasetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [importOpen, setImportOpen] = useState(false);

  async function load() {
    setLoading(true);
    const qs = workspaceId ? `?workspaceId=${workspaceId}` : '';
    const res = await fetch(`/api/datasets${qs}`);
    const json = await res.json();
    setDatasets(json.datasets ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function createEmptyDataset() {
    const name = prompt('Dataset name (e.g. "Placement Students September 2026")');
    if (!name) return;
    const res = await fetch('/api/datasets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, workspaceId: workspaceId ?? undefined }),
    });
    if (!res.ok) {
      toast.error('Failed to create dataset');
      return;
    }
    toast.success('Dataset created');
    load();
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Data</h1>
          <p className="text-sm text-muted-foreground">Datasets are collections of records — the spreadsheet layer.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={createEmptyDataset} className="btn-secondary">
            + New empty dataset
          </button>
          <button
            onClick={() => setImportOpen(true)}
            className="btn-primary"
          >
            Import data
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : datasets.length === 0 ? (
        <div className="mt-16 text-center text-sm text-muted-foreground">
          Import your first dataset to get started.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Records</th>
                <th className="px-4 py-2">Columns</th>
                <th className="px-4 py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {datasets.map((d) => (
                <tr key={d.id} className="border-t hover:bg-elevated/60">
                  <td className="px-4 py-2">
                    <Link href={`/data/${d.id}`} className="font-medium text-primary hover:underline">
                      {d.name}
                    </Link>
                    {d.description && <div className="text-xs text-muted-foreground">{d.description}</div>}
                  </td>
                  <td className="px-4 py-2">{d._count.records}</td>
                  <td className="px-4 py-2">{d._count.columns}</td>
                  <td className="px-4 py-2 text-muted-foreground">{new Date(d.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={load} />
    </div>
  );
}
