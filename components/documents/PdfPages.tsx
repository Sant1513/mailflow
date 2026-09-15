'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageInfo } from '@/lib/documents/types';

type PdfJs = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<PdfJs> | null = null;

/** pdf.js touches browser globals on import, so it is loaded lazily on the client only. */
function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
      return lib;
    });
  }
  return pdfjsPromise;
}

/**
 * Renders every page of a PDF to canvas at `scale` screen pixels per point,
 * with an overlay layer per page. Page sizes come from the server's
 * inspection — the same numbers the generator uses — so boxes drawn here
 * land exactly where the text is written.
 */
export function PdfPages({
  src,
  pages,
  scale,
  reloadKey,
  renderOverlay,
  onPageClick,
  cursor,
}: {
  src: string;
  pages: PageInfo[];
  scale: number;
  reloadKey?: string | number;
  renderOverlay?: (pageIndex: number) => ReactNode;
  onPageClick?: (pageIndex: number, point: { x: number; y: number }) => void;
  cursor?: string;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setDoc(null);
    setError(null);
    loadPdfJs()
      .then((lib) => lib.getDocument({ url: src, withCredentials: true }).promise)
      .then((d) => {
        loaded = d;
        if (cancelled) void d.destroy();
        else setDoc(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e?.message ?? 'unknown error');
      });
    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
  }, [src, reloadKey]);

  if (error) {
    return <div className="p-6 text-sm text-primary">The PDF could not be displayed ({error}). Try reloading the page.</div>;
  }

  return (
    <div className="flex flex-col items-center gap-6 pb-10">
      {pages.map((info, index) => (
        <div key={index} data-page-index={index} className="scroll-mt-14">
          <div className="mb-1 text-[11px] text-faint">
            Page {index + 1}
            {info.rotation ? ` · rotated ${info.rotation}°` : ''}
          </div>
          <PdfPage doc={doc} index={index} info={info} scale={scale} overlay={renderOverlay?.(index)} onClick={onPageClick} cursor={cursor} />
        </div>
      ))}
    </div>
  );
}

function PdfPage({
  doc,
  index,
  info,
  scale,
  overlay,
  onClick,
  cursor,
}: {
  doc: PDFDocumentProxy | null;
  index: number;
  info: PageInfo;
  scale: number;
  overlay?: ReactNode;
  onClick?: (pageIndex: number, point: { x: number; y: number }) => void;
  cursor?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState(false);
  const sideways = info.rotation === 90 || info.rotation === 270;
  const width = (sideways ? info.height : info.width) * scale;
  const height = (sideways ? info.width : info.height) * scale;

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    setRendered(false);
    doc
      .getPage(index + 1)
      .then((page) => {
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: scale * ratio });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) return;
        task = page.render({ canvasContext: context, viewport });
        return task.promise.then(() => {
          if (!cancelled) setRendered(true);
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, index, scale]);

  return (
    <div className="relative shrink-0 bg-white shadow-md ring-1 ring-black/10" style={{ width, height }}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {!rendered && <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-400">Rendering…</div>}
      <div
        data-page-surface
        className="absolute inset-0"
        style={{ cursor }}
        onClick={(e) => {
          if (!onClick) return;
          const rect = e.currentTarget.getBoundingClientRect();
          onClick(index, { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale });
        }}
      />
      <div className="pointer-events-none absolute inset-0">{overlay}</div>
    </div>
  );
}
