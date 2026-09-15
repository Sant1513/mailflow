'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { LOCK_MODE_LABELS, MAX_UPLOAD_BYTES, type LockMode } from '@/lib/documents/types';

interface DocumentRow {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  updatedAt: string;
  owner: string;
  fileName: string;
  size: number;
  pageCount: number;
  formFieldCount: number;
  fieldCount: number;
  lockMode: LockMode;
  campaignCount: number;
}

const STEPS = [
  ['Upload a PDF', 'An agreement, offer letter, consent form or NOC. Fillable PDFs work best; flat or scanned PDFs work too.'],
  ['Map the fields', 'Point each fillable field or a box on the page at a column: {{Name}}, {{Batch}}, {{Today}}.'],
  ['Attach to a campaign', 'Every recipient receives their own filled copy, attached to their email, with a unique reference.'],
];

export default function DocumentsPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function load() {
    setLoading(true);
    const res = await fetch(`/api/documents?includeArchived=${showArchived}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) toast.error(json.error ?? 'Could not load documents');
    setRows(json.documents ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived]);

  async function upload(file: File) {
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      toast.error('Choose a PDF file.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error(`That PDF is ${(file.size / 1048576).toFixed(1)} MB; the limit is 4 MB.`);
      return;
    }
    setUploading(true);
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/documents', { method: 'POST', body: form });
    const json = await res.json().catch(() => ({}));
    setUploading(false);
    if (!res.ok) {
      toast.error(json.error ?? 'Upload failed');
      return;
    }
    const found = json.inspection?.formFields?.length ?? 0;
    toast.success(`Uploaded: ${json.inspection?.pageCount ?? '?'} page(s), ${found} fillable field(s) found.`);
    router.push(`/documents/${json.document.id}`);
  }

  async function setArchived(row: DocumentRow, archived: boolean) {
    const res = await fetch(`/api/documents/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json.error ?? 'Could not update');
      return;
    }
    toast.success(archived ? 'Archived' : 'Restored');
    load();
  }

  async function remove(row: DocumentRow) {
    const note = row.campaignCount > 0 ? ' It is used by campaigns, so it will be archived instead.' : '';
    if (!confirm(`Delete "${row.name}"?${note}`)) return;
    const res = await fetch(`/api/documents/${row.id}`, { method: 'DELETE' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json.error ?? 'Could not delete');
      return;
    }
    toast.success(json.message ?? 'Deleted');
    load();
  }

  return (
    <div
      className="relative p-6"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) upload(file);
      }}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Documents</h1>
          <p className="text-sm text-muted-foreground">
            PDF agreements, letters and forms, personalised for every recipient of a campaign.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>
          <button onClick={() => inputRef.current?.click()} disabled={uploading} className="btn-primary">
            {uploading ? 'Uploading…' : 'Upload PDF'}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) upload(file);
            }}
          />
        </div>
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-4 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5 text-sm font-medium text-primary">
          Drop the PDF to upload it
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="mx-auto mt-10 max-w-3xl">
          <div className="grid gap-3 sm:grid-cols-3">
            {STEPS.map(([title, body], i) => (
              <div key={title} className="rounded-lg border bg-card p-4">
                <div className="eyebrow mb-1">Step {i + 1}</div>
                <div className="mb-1 text-sm font-semibold">{title}</div>
                <p className="text-xs text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
          <button
            onClick={() => inputRef.current?.click()}
            className="mt-4 w-full rounded-lg border-2 border-dashed p-8 text-sm text-muted-foreground hover:border-primary hover:text-primary"
          >
            Drop a PDF here or click to upload (max 4 MB, 50 pages)
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Document</th>
                <th className="px-4 py-2">PDF</th>
                <th className="px-4 py-2">Fields</th>
                <th className="px-4 py-2">Student can</th>
                <th className="px-4 py-2">Used in</th>
                <th className="px-4 py-2">Updated</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="border-t hover:bg-elevated/60">
                  <td className="px-4 py-2">
                    <Link href={`/documents/${d.id}`} className="font-medium text-primary hover:underline">
                      {d.name}
                    </Link>
                    {d.archived && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px]">ARCHIVED</span>}
                    <div className="text-xs text-muted-foreground">by {d.owner}</div>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {d.fileName}
                    <div>
                      {d.pageCount} page(s) · {Math.max(1, Math.round(d.size / 1024))} KB
                    </div>
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {d.fieldCount === 0 ? <span className="text-warning">Not mapped yet</span> : `${d.fieldCount} mapped`}
                    {d.formFieldCount > 0 && <div className="text-muted-foreground">{d.formFieldCount} fillable in PDF</div>}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{LOCK_MODE_LABELS[d.lockMode].label.split(' — ')[1] ?? d.lockMode}</td>
                  <td className="px-4 py-2 text-xs">{d.campaignCount} campaign(s)</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{new Date(d.updatedAt).toLocaleString('en-IN')}</td>
                  <td className="px-4 py-2">
                    <div className="flex gap-3 text-xs">
                      <button onClick={() => setArchived(d, !d.archived)} className="text-muted-foreground hover:text-foreground">
                        {d.archived ? 'Restore' : 'Archive'}
                      </button>
                      <button onClick={() => remove(d)} className="text-muted-foreground hover:text-primary">
                        Delete
                      </button>
                    </div>
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
