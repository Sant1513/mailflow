'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';

interface LibraryDoc {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  updatedAt: string;
  owner: string;
  fileName: string;
  size: number;
  pageCount: number;
  fieldCount: number;
  lockMode: string;
  campaignCount: number;
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function DocumentLibraryPage() {
  const [docs, setDocs] = useState<LibraryDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load(archived = includeArchived) {
    setLoading(true);
    const res = await fetch(`/api/documents?includeArchived=${archived}`);
    setLoading(false);
    if (!res.ok) return;
    const json = (await res.json()) as { documents: LibraryDoc[] };
    setDocs(json.documents ?? []);
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('Only PDF files are supported.');
      e.target.value = '';
      return;
    }
    setUploading(true);
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/documents', { method: 'POST', body: fd });
    setUploading(false);
    e.target.value = '';
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(json.error ?? 'Upload failed');
      return;
    }
    const json = (await res.json()) as { document: { id: string; name: string } };
    toast.success(`"${json.document.name}" uploaded — open it to configure fields`);
    await load();
  }

  async function toggleArchive(doc: LibraryDoc) {
    const res = await fetch(`/api/documents/${doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: !doc.archived }),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(json.error ?? 'Action failed');
      return;
    }
    toast.success(doc.archived ? `"${doc.name}" restored` : `"${doc.name}" archived`);
    await load();
  }

  const visible = docs.filter((d) => includeArchived || !d.archived);

  return (
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">PDF Document Library</h1>
          <p className="text-sm text-muted-foreground">
            Personalised PDFs attached to campaign emails. Each recipient gets their own filled-in copy.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => { setIncludeArchived(e.target.checked); load(e.target.checked); }}
              className="accent-primary"
            />
            Show archived
          </label>
          <label className={`btn-primary cursor-pointer ${uploading ? 'opacity-60 pointer-events-none' : ''}`}>
            {uploading ? 'Uploading…' : 'Upload PDF'}
            <input ref={fileRef} type="file" accept=".pdf,application/pdf" className="sr-only" onChange={handleUpload} disabled={uploading} />
          </label>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : visible.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm font-medium text-muted-foreground">No documents in the library yet.</p>
          <p className="mt-1 text-xs text-muted-foreground">Upload a PDF to get started — then open it to map fields to your dataset columns.</p>
          <label className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90">
            Upload PDF
            <input type="file" accept=".pdf,application/pdf" className="sr-only" onChange={handleUpload} disabled={uploading} />
          </label>
        </div>
      ) : (
        <div className="rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2 text-left">Document</th>
                <th className="px-4 py-2 text-left">File</th>
                <th className="px-4 py-2 text-center">Fields</th>
                <th className="px-4 py-2 text-center">Pages</th>
                <th className="px-4 py-2 text-center">Used in</th>
                <th className="px-4 py-2 text-left">Updated</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((d) => (
                <tr key={d.id} className={`border-b last:border-0 hover:bg-muted/20 transition-colors ${d.archived ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3">
                    <div className="font-medium">
                      {d.archived ? (
                        <span className="text-muted-foreground">{d.name}</span>
                      ) : (
                        <Link href={`/documents/${d.id}`} className="hover:text-primary hover:underline">
                          {d.name}
                        </Link>
                      )}
                      {d.archived && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase">archived</span>}
                    </div>
                    {d.description && <div className="mt-0.5 text-xs text-muted-foreground">{d.description}</div>}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    <div>{d.fileName}</div>
                    <div>{fmtSize(d.size)}</div>
                  </td>
                  <td className="px-4 py-3 text-center">{d.fieldCount}</td>
                  <td className="px-4 py-3 text-center">{d.pageCount}</td>
                  <td className="px-4 py-3 text-center text-xs text-muted-foreground">
                    {d.campaignCount} campaign{d.campaignCount !== 1 ? 's' : ''}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {new Date(d.updatedAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}
                  </td>
                  <td className="px-4 py-3 text-right text-xs">
                    <div className="flex items-center justify-end gap-3">
                      {!d.archived && (
                        <Link href={`/documents/${d.id}`} className="text-primary hover:underline">
                          Edit
                        </Link>
                      )}
                      <button onClick={() => toggleArchive(d)} className="text-muted-foreground hover:text-foreground">
                        {d.archived ? 'Restore' : 'Archive'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-6 text-xs text-muted-foreground">
        After uploading, open a document to configure field mappings (which dataset columns fill which PDF fields).{' '}
        <Link href="/documents" className="text-primary hover:underline">View signing requests →</Link>
      </p>
    </div>
  );
}
