'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';

export interface ImportedDoc {
  title: string;
  content: string;
  fields: { key: string; label: string }[];
}

/**
 * "Import from Word / Google Doc": converts the document to template HTML
 * with its {{fields}} detected. The caller decides how to merge it in.
 */
export function DocImportButton({ onImported, hasContent }: { onImported: (doc: ImportedDoc) => void; hasContent: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(init: RequestInit) {
    if (hasContent && !confirm('Replace the current document content with the imported one?')) return;
    setBusy(true);
    const res = await fetch('/api/signing-templates/import', { method: 'POST', ...init });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      toast.error(json.error ?? 'Import failed');
      return;
    }
    const doc = json as ImportedDoc & { warnings?: string[] };
    onImported(doc);
    for (const w of doc.warnings ?? []) toast.warning(w, { duration: 10000 });
    setOpen(false);
    setUrl('');
    toast.success(
      doc.fields.length
        ? `Imported. ${doc.fields.length} field${doc.fields.length !== 1 ? 's' : ''} found: ${doc.fields.map((f) => f.key).join(', ')}`
        : 'Imported. No {{fields}} found: add them where each person’s details go.',
      { duration: 8000 },
    );
  }

  function uploadFile(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    run({ body: fd });
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="btn-secondary !px-3 !py-1 text-xs" disabled={busy}>
        {busy ? 'Importing…' : 'Import from Word / Google Doc'}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-80 space-y-3 rounded-md border bg-card p-3 text-xs shadow-lg">
          <div>
            <div className="mb-1 font-medium">Word file (.docx)</div>
            <input
              ref={fileRef}
              type="file"
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadFile(f);
              }}
              className="text-xs"
            />
          </div>
          <div>
            <div className="mb-1 font-medium">Google Doc link</div>
            <div className="flex gap-2">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://docs.google.com/document/d/…"
                className="flex-1 !py-1 text-xs"
              />
              <button
                type="button"
                disabled={!url.trim() || busy}
                onClick={() => run({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.trim() }) })}
                className="btn-primary !px-2 !py-1 text-xs"
              >
                Import
              </button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">The doc must be shared as &quot;Anyone with the link can view&quot;.</p>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Write fields as <code className="font-mono">{'{{student_name}}'}</code> in the document; they are detected automatically. Put{' '}
            <code className="font-mono">[[signature]]</code> where the signature goes.
          </p>
        </div>
      )}
    </div>
  );
}
