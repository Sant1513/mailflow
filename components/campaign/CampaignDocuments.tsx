'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { LOCK_MODE_LABELS, type LockMode } from '@/lib/documents/types';

interface AttachedDocument {
  id: string;
  documentTemplateId: string;
  name: string;
  fileName: string;
  pageCount: number;
  size: number;
  fields: { id: string; label: string; value: string; required: boolean }[];
  fileNamePattern: string;
  lockMode: LockMode;
  stampReference: boolean;
  snapshotAt: string;
  drift: string[];
  libraryArchived: boolean;
  issues: { level: 'error' | 'warning'; message: string }[];
}

interface Payload {
  documents: AttachedDocument[];
  editable: boolean;
  lockedReason: string | null;
  maxDocuments: number;
}

interface LibraryDocument {
  id: string;
  name: string;
  fieldCount: number;
  pageCount: number;
}

/** Campaign page panel: which personalised PDFs go with every email, and their state. */
export function CampaignDocuments({
  campaignId,
  onChanged,
  onPreview,
}: {
  campaignId: string;
  onChanged: () => void;
  onPreview: (campaignDocumentId: string, name: string) => void;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [library, setLibrary] = useState<LibraryDocument[]>([]);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/campaigns/${campaignId}/documents`);
    const json = await res.json().catch(() => ({}));
    if (res.ok) setData(json);
  }, [campaignId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!data?.editable) return;
    fetch('/api/documents')
      .then((r) => r.json())
      .then((j) => setLibrary(j.documents ?? []))
      .catch(() => undefined);
  }, [data?.editable]);

  async function act(key: string, request: () => Promise<Response>, success: string) {
    setBusy(key);
    const res = await request();
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      toast.error(json.error ?? 'Action failed');
      return;
    }
    toast.success(success);
    setChoice('');
    await load();
    onChanged();
  }

  if (!data) return null;
  const attached = new Set(data.documents.map((d) => d.documentTemplateId));
  const available = library.filter((l) => !attached.has(l.id));

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Personalised PDFs</h2>
          <p className="text-xs text-muted-foreground">
            Every recipient gets their own copy with their details filled in, attached to their email.
          </p>
        </div>
        <Link href="/documents/library" className="text-xs text-primary hover:underline">
          Manage documents
        </Link>
      </div>

      {!data.editable && data.lockedReason && data.documents.length > 0 && (
        <p className="mb-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{data.lockedReason}</p>
      )}

      {data.documents.length === 0 ? (
        <p className="text-xs text-muted-foreground">No documents attached.</p>
      ) : (
        <ul className="space-y-2">
          {data.documents.map((d) => {
            const errors = d.issues.filter((i) => i.level === 'error');
            const warnings = d.issues.filter((i) => i.level === 'warning');
            return (
              <li key={d.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">📎 {d.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {d.fields.length} field(s) · {d.pageCount} page(s) · {LOCK_MODE_LABELS[d.lockMode].label.split(' — ')[0]} · saved as “{d.fileNamePattern}”
                    </div>
                    <div className="text-[11px] text-faint">Attached version from {new Date(d.snapshotAt).toLocaleString('en-IN')}</div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <button onClick={() => onPreview(d.id, d.name)} className="rounded border px-2 py-1 text-xs hover:bg-elevated">
                      Preview PDF
                    </button>
                    {data.editable && d.drift.length > 0 && !d.libraryArchived && (
                      <button
                        disabled={!!busy}
                        onClick={() =>
                          act(
                            `refresh-${d.id}`,
                            () =>
                              fetch(`/api/campaigns/${campaignId}/documents/${d.id}`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: 'refresh' }),
                              }),
                            `${d.name} updated to the latest version`
                          )
                        }
                        className="rounded border border-warning/50 px-2 py-1 text-xs text-warning hover:bg-warning/10"
                      >
                        Update to latest
                      </button>
                    )}
                    {data.editable && (
                      <button
                        disabled={!!busy}
                        onClick={() =>
                          act(`remove-${d.id}`, () => fetch(`/api/campaigns/${campaignId}/documents/${d.id}`, { method: 'DELETE' }), `${d.name} removed`)
                        }
                        className="rounded border px-2 py-1 text-xs text-muted-foreground hover:text-primary"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
                {d.drift.length > 0 && (
                  <p className="mt-2 text-xs text-warning">
                    The library version changed since this was attached ({d.drift.join(', ')}). This campaign keeps sending the attached version
                    {data.editable ? ' until you update it.' : '.'}
                  </p>
                )}
                {errors.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-xs text-primary">
                    {errors.map((issue, i) => (
                      <li key={i}>✕ {issue.message}</li>
                    ))}
                  </ul>
                )}
                {warnings.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-warning">
                    {warnings.map((issue, i) => (
                      <li key={i}>! {issue.message}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {data.editable && data.documents.length < data.maxDocuments && (
        <div className="mt-3 flex flex-wrap gap-2">
          <select value={choice} onChange={(e) => setChoice(e.target.value)} className="min-w-[240px] rounded-md border px-2 py-1.5 text-sm">
            <option value="">{available.length ? 'Attach a document…' : 'No more documents in the library'}</option>
            {available.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.fieldCount} field{l.fieldCount === 1 ? '' : 's'}, {l.pageCount} page{l.pageCount === 1 ? '' : 's'})
              </option>
            ))}
          </select>
          <button
            disabled={!choice || !!busy}
            onClick={() =>
              act(
                'add',
                () =>
                  fetch(`/api/campaigns/${campaignId}/documents`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ documentTemplateId: choice }),
                  }),
                'Document attached'
              )
            }
            className="btn-secondary"
          >
            {busy === 'add' ? 'Attaching…' : 'Attach'}
          </button>
        </div>
      )}
    </div>
  );
}
