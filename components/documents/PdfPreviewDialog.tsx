'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { DocumentPreviewResult } from '@/lib/documents/campaign';

/**
 * Opens a generated preview copy: the PDF itself (browser viewer), every
 * resolved value, what would block this recipient, and any warnings.
 */
export function useDocumentPreview() {
  const [state, setState] = useState<{ title: string; loading: boolean; preview: DocumentPreviewResult | null } | null>(null);

  const openPreview = useCallback(async (endpoint: string, body: unknown, title: string) => {
    setState({ title, loading: true, preview: null });
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Could not generate the preview');
        setState(null);
        return null;
      }
      setState({ title, loading: false, preview: json.preview });
      return json as { preview: DocumentPreviewResult; issues?: { level: string; message: string; fieldId?: string }[] };
    } catch {
      toast.error('Could not generate the preview');
      setState(null);
      return null;
    }
  }, []);

  const close = useCallback(() => setState(null), []);
  const previewDialog = state ? <PdfPreviewDialog title={state.title} loading={state.loading} preview={state.preview} onClose={close} /> : null;
  return { openPreview, previewDialog };
}

export function PdfPreviewDialog({
  title,
  loading,
  preview,
  onClose,
}: {
  title: string;
  loading: boolean;
  preview: DocumentPreviewResult | null;
  onClose: () => void;
}) {
  const url = useMemo(() => {
    if (!preview?.pdfBase64) return null;
    const binary = atob(preview.pdfBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  }, [preview?.pdfBase64]);

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 sm:p-6" onClick={onClose}>
      <div className="panel flex w-full max-w-6xl flex-col overflow-hidden" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="PDF preview">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <div className="eyebrow">Preview · nothing is sent</div>
            <div className="truncate font-heading text-base font-bold">{preview?.fileName ?? title}</div>
          </div>
          <div className="flex shrink-0 gap-2">
            {url && preview && (
              <a href={url} download={preview.fileName} className="btn-secondary !py-1.5 text-xs">
                Download
              </a>
            )}
            <button onClick={onClose} className="btn-secondary !py-1.5 text-xs">
              Close
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-1 items-center justify-center p-10 text-sm text-muted-foreground">Generating the PDF…</div>
        ) : preview ? (
          <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[1fr_320px] lg:overflow-hidden">
            <div className="min-h-[60vh] bg-muted/40">
              {preview.ok && url ? (
                <iframe title="Generated PDF" src={url} className="h-full min-h-[60vh] w-full" />
              ) : (
                <div className="p-6 text-sm text-primary">{preview.error ?? 'The PDF could not be generated.'}</div>
              )}
            </div>
            <aside className="min-h-0 overflow-y-auto border-t p-4 text-xs lg:border-l lg:border-t-0">
              {preview.blocking.length > 0 && (
                <div className="mb-3 rounded-md border border-primary/40 bg-primary/10 p-2 text-primary">
                  Required value empty: {preview.blocking.join(', ')}. A recipient like this is skipped, not sent a blank document.
                </div>
              )}
              {preview.warnings.length > 0 && (
                <ul className="mb-3 space-y-1 rounded-md border border-warning/40 bg-warning/10 p-2 text-warning">
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
              <div className="eyebrow mb-2">Values written</div>
              {preview.fields.length === 0 ? (
                <p className="text-muted-foreground">No fields: the PDF is attached as it is.</p>
              ) : (
                <dl className="space-y-2">
                  {preview.fields.map((f) => (
                    <div key={f.id}>
                      <dt className="text-faint">
                        {f.label}
                        {f.required ? '' : ' · optional'}
                      </dt>
                      <dd className={`whitespace-pre-wrap break-words font-medium ${f.missing.length ? 'text-warning' : ''}`}>
                        {f.value || <span className="italic text-faint">blank</span>}
                        {f.usedFallback && <span className="ml-1 font-normal text-faint">(fallback)</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="mt-4 text-faint">
                Reference {preview.reference}
                {preview.size ? ` · ${Math.max(1, Math.round(preview.size / 1024))} KB` : ''}
              </div>
            </aside>
          </div>
        ) : null}
      </div>
    </div>
  );
}
