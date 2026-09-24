'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { extractSigningVariables, labelForSigningField, renderSigningContent } from '@/lib/signing/fields';
import { renderSignatureTokensHtml, stripSignatureTokens } from '@/lib/signing/signature-tokens';
import { placedSignerIndices, type SignaturePlacement } from '@/lib/signing/placements';

export interface PreviewSigner {
  role: string;
  name?: string;
}

export interface PreviewPayload {
  title: string;
  content: string;
  fieldValues: Record<string, string>;
  signers: PreviewSigner[];
  recipientName?: string;
  recipientEmail?: string;
  placements?: SignaturePlacement[];
}

export function renderPreviewHtml(
  content: string,
  values: Record<string, string>,
  signers: PreviewSigner[],
  highlightSigner?: number,
): string {
  const withValues = renderSigningContent(content, values, { highlight: true, friendlyBlanks: true });
  return renderSignatureTokensHtml(
    withValues,
    signers.map((s, i) => ({ signerIndex: i + 1, role: s.role, name: s.name })),
    { highlightSigner },
  );
}

export function DocumentHtmlPane({ payload, className = '' }: { payload: PreviewPayload; className?: string }) {
  const placed = placedSignerIndices(payload.placements ?? []);
  return (
    <>
      {placed.length > 0 && (
        <p className="mb-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs text-blue-900">
          Signature positions for {placed.map((i) => payload.signers[i - 1]?.role ?? `Signer ${i}`).join(', ')} are set on
          the page. Open the PDF tab to see exactly where they land.
        </p>
      )}
      <div
        className={`rounded-md border bg-white p-5 text-sm leading-relaxed text-gray-800 ${className}`}
        dangerouslySetInnerHTML={{
          __html: renderPreviewHtml(stripSignatureTokens(payload.content, placed), payload.fieldValues, payload.signers),
        }}
      />
    </>
  );
}

export function usePdfPreview() {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const urlRef = useRef<string | null>(null);

  const generate = useCallback(async (payload: PreviewPayload) => {
    setLoading(true);
    try {
      const res = await fetch('/api/e-sign/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(json.error ?? 'Could not generate the PDF preview');
        return;
      }
      const next = URL.createObjectURL(await res.blob());
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = next;
      setUrl(next);
    } catch {
      toast.error('Could not generate the PDF preview');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  return { url, loading, generate };
}

export function PdfPane({ url, loading, onGenerate }: { url: string | null; loading: boolean; onGenerate: () => void }) {
  if (loading) {
    return <div className="flex min-h-[60vh] items-center justify-center text-sm text-muted-foreground">Generating the PDF…</div>;
  }
  if (!url) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>See the exact PDF the signer will receive (without signatures).</p>
        <button type="button" onClick={onGenerate} className="btn-primary !py-1.5 text-xs">
          Generate PDF preview
        </button>
      </div>
    );
  }
  return <iframe title="PDF preview" src={url} className="h-full min-h-[60vh] w-full rounded-md border bg-muted/40" />;
}

export function FieldStatusList({
  content,
  values,
  lockedFields,
}: {
  content: string;
  values: Record<string, string>;
  lockedFields?: string[];
}) {
  const keys = extractSigningVariables(content);
  if (keys.length === 0) return <p className="text-xs text-muted-foreground">This document has no fields.</p>;
  return (
    <dl className="space-y-2 text-xs">
      {keys.map((k) => {
        const value = (values[k] ?? '').trim();
        const locked = lockedFields ? lockedFields.includes(k) && !!value : !!value;
        return (
          <div key={k}>
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              {labelForSigningField(k)}
              <span className={`rounded px-1 text-[10px] font-medium ${locked ? 'bg-muted text-foreground' : 'bg-amber-100 text-amber-800'}`}>
                {locked ? 'Locked' : 'Signer fills'}
              </span>
            </dt>
            <dd className="break-words font-medium">{value || <span className="italic text-muted-foreground">blank</span>}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Read-only preview of an unsent document: rendered HTML plus the real PDF. */
export function SigningPreviewModal({ payload, onClose }: { payload: PreviewPayload; onClose: () => void }) {
  const [tab, setTab] = useState<'doc' | 'pdf'>('doc');
  const pdf = usePdfPreview();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function openPdf() {
    setTab('pdf');
    if (!pdf.url && !pdf.loading) void pdf.generate(payload);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 sm:p-6" onClick={onClose}>
      <div className="panel flex w-full max-w-6xl flex-col overflow-hidden" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Document preview">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <div className="eyebrow">Preview · nothing is sent</div>
            <div className="truncate text-base font-bold">{payload.title || 'Untitled document'}</div>
            {payload.recipientName && (
              <div className="truncate text-xs text-muted-foreground">
                For {payload.recipientName}
                {payload.recipientEmail ? ` · ${payload.recipientEmail}` : ''}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <PreviewTabs tab={tab} onDoc={() => setTab('doc')} onPdf={openPdf} />
            <button type="button" onClick={onClose} className="btn-secondary !py-1.5 text-xs">
              Close
            </button>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[1fr_300px] lg:overflow-hidden">
          <div className="min-h-0 overflow-y-auto bg-muted/30 p-4">
            {tab === 'doc' ? (
              <DocumentHtmlPane payload={payload} />
            ) : (
              <PdfPane url={pdf.url} loading={pdf.loading} onGenerate={() => void pdf.generate(payload)} />
            )}
          </div>
          <aside className="min-h-0 overflow-y-auto border-t p-4 lg:border-l lg:border-t-0">
            <div className="eyebrow mb-2">Field values</div>
            <FieldStatusList content={payload.content} values={payload.fieldValues} />
            <p className="mt-4 text-[11px] text-muted-foreground">
              Filled values are locked for the signer. Blank fields are shown in red on the signing page and must be filled
              in before signing.
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}

export function PreviewTabs({ tab, onDoc, onPdf }: { tab: 'doc' | 'pdf'; onDoc: () => void; onPdf: () => void }) {
  return (
    <div className="flex overflow-hidden rounded-md border text-xs">
      <button type="button" onClick={onDoc} className={`px-3 py-1.5 ${tab === 'doc' ? 'bg-foreground text-background' : 'hover:bg-muted'}`}>
        Document
      </button>
      <button type="button" onClick={onPdf} className={`border-l px-3 py-1.5 ${tab === 'pdf' ? 'bg-foreground text-background' : 'hover:bg-muted'}`}>
        PDF
      </button>
    </div>
  );
}
