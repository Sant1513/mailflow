'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { PdfPages } from './PdfPages';
import { boxAtPoint, moveBox, resizeBox, toPixels, type Box } from '@/lib/documents/geometry';
import {
  DEFAULT_SIGNATURE_BOX,
  MIN_PLACEMENT,
  SIGNING_PAGE,
  anchorPlacement,
  resolvePlacement,
  type AnchorPosition,
  type SignaturePlacement,
} from '@/lib/signing/placements';

export interface PlacementSigner {
  index: number; // 1-based
  role: string;
}

export const SIGNER_BOX_COLORS = [
  { bg: 'rgba(219,234,254,0.85)', text: '#1d4ed8', border: '#3b82f6' },
  { bg: 'rgba(220,252,231,0.85)', text: '#15803d', border: '#22c55e' },
  { bg: 'rgba(255,237,213,0.85)', text: '#c2410c', border: '#f97316' },
];

export function signerColor(index: number) {
  return SIGNER_BOX_COLORS[(index - 1) % SIGNER_BOX_COLORS.length]!;
}

const PAGE_INFO = { width: SIGNING_PAGE.width, height: SIGNING_PAGE.height, rotation: 0 };

type Drag = { idx: number; mode: 'move' | 'resize'; startX: number; startY: number; box: Box };

/**
 * Drag-and-drop signature placement on the real generated pages. Pick a
 * signer, click the page to drop a box, drag it to move, pull the corner to
 * resize. Positions are PDF points, exactly what the PDF generator draws.
 */
export function SignaturePlacementEditor({
  title,
  content,
  fieldValues,
  signers,
  value,
  onSave,
  onClose,
  footer,
}: {
  title: string;
  content: string;
  fieldValues: Record<string, string>;
  signers: PlacementSigner[];
  value: SignaturePlacement[];
  onSave: (placements: SignaturePlacement[]) => void;
  onClose: () => void;
  /** Extra controls rendered above the Save button (e.g. "save as template default"). */
  footer?: ReactNode;
}) {
  const [placements, setPlacements] = useState<SignaturePlacement[]>(() =>
    value.filter((p) => signers.some((s) => s.index === p.signerIndex)),
  );
  const [active, setActive] = useState(signers[0]?.index ?? 1);
  const [selected, setSelected] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pdf, setPdf] = useState<{ data: ArrayBuffer; pageCount: number } | null>(null);
  const [anchors, setAnchors] = useState<AnchorPosition[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/e-sign/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title || 'Document',
        content,
        fieldValues,
        signers: signers.map((s) => ({ role: s.role })),
        placements: [],
        withAnchors: true,
      }),
    })
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
          pdf?: string;
          pageCount?: number;
          anchors?: AnchorPosition[];
        };
        if (!res.ok || !json.pdf) throw new Error(json.error ?? 'Could not render the document');
        const bytes = Uint8Array.from(atob(json.pdf), (c) => c.charCodeAt(0));
        if (cancelled) return;
        const found = json.anchors ?? [];
        setAnchors(found);
        // Show saved boxes where they land in *this* render (text may have moved).
        const byId = new Map(found.map((a) => [a.id, a]));
        setPlacements((all) => all.map((p) => ({ ...p, ...resolvePlacement(p, byId) })));
        setPdf({ data: bytes.buffer, pageCount: json.pageCount || 1 });
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadError(e.message);
      });
    return () => {
      cancelled = true;
    };
    // The preview only needs to render once per open; later edits happen on top of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Move/resize measured from where the drag started, so boxes never drift.
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const box = d.mode === 'move' ? moveBox(d.box, dx, dy, zoom, PAGE_INFO) : resizeBox(d.box, dx, dy, zoom, PAGE_INFO, MIN_PLACEMENT);
      setPlacements((all) => all.map((p, i) => (i === d.idx ? { ...p, ...box } : p)));
    }
    function onUp() {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.userSelect = '';
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [zoom]);

  const removeAt = useCallback((idx: number) => {
    setPlacements((all) => all.filter((_, i) => i !== idx));
    setSelected(null);
  }, []);

  // Delete removes the selected box; arrows nudge it (Shift = 10pt); Esc deselects.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') {
        setSelected(null);
        return;
      }
      if (selected === null) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeAt(selected);
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!delta) return;
      e.preventDefault();
      setPlacements((all) =>
        all.map((p, i) => (i === selected ? { ...p, ...moveBox(p, delta[0]!, delta[1]!, 1, PAGE_INFO) } : p)),
      );
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, removeAt]);

  function addAt(page: number, point: { x: number; y: number }) {
    const box = boxAtPoint(point.x, point.y, PAGE_INFO, DEFAULT_SIGNATURE_BOX);
    setPlacements((all) => [...all, { signerIndex: active, page, ...box }]);
    setSelected(placements.length);
  }

  function startDrag(e: React.PointerEvent, idx: number, mode: Drag['mode']) {
    e.preventDefault();
    e.stopPropagation();
    const p = placements[idx];
    if (!p) return;
    setSelected(idx);
    drag.current = { idx, mode, startX: e.clientX, startY: e.clientY, box: { x: p.x, y: p.y, width: p.width, height: p.height } };
    document.body.style.userSelect = 'none';
  }

  const roleOf = (index: number) => signers.find((s) => s.index === index)?.role ?? `Signer ${index}`;
  const missing = signers.filter((s) => !placements.some((p) => p.signerIndex === s.index));

  const overlay = (pageIndex: number) =>
    placements.map((p, idx) => {
      if (p.page !== pageIndex) return null;
      const px = toPixels(p, zoom);
      const c = signerColor(p.signerIndex);
      const isSel = selected === idx;
      return (
        <div
          key={idx}
          onPointerDown={(e) => startDrag(e, idx, 'move')}
          onClick={(e) => e.stopPropagation()}
          className="pointer-events-auto absolute flex cursor-move select-none items-center justify-center rounded-[3px] text-center"
          style={{
            left: px.left,
            top: px.top,
            width: px.width,
            height: px.height,
            background: c.bg,
            border: `${isSel ? 2 : 1.5}px dashed ${c.border}`,
            boxShadow: isSel ? `0 0 0 3px ${c.border}33` : undefined,
            touchAction: 'none',
          }}
          title={`${roleOf(p.signerIndex)} · drag to move, corner to resize, Delete to remove`}
        >
          <span className="pointer-events-none truncate px-1 font-semibold leading-tight" style={{ color: c.text, fontSize: Math.max(9, Math.min(12, px.height * 0.3)) }}>
            {roleOf(p.signerIndex)}
          </span>
          {isSel && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                removeAt(idx);
              }}
              className="absolute -right-2 -top-2 flex h-4 w-4 items-center justify-center rounded-full bg-white text-[10px] leading-none shadow ring-1 ring-black/20"
              aria-label="Remove box"
            >
              ×
            </button>
          )}
          <span
            onPointerDown={(e) => startDrag(e, idx, 'resize')}
            className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm"
            style={{ background: c.border, border: '1px solid white', touchAction: 'none' }}
            title="Drag to resize"
          />
        </div>
      );
    });

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 sm:p-6">
      <div className="panel flex w-full max-w-6xl flex-col overflow-hidden" role="dialog" aria-label="Place signatures">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <div className="eyebrow">Signature positions</div>
            <div className="truncate text-base font-bold">{title || 'Document'}</div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <button type="button" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(1)))} className="btn-secondary !px-2 !py-1">
              −
            </button>
            <span className="w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.2).toFixed(1)))} className="btn-secondary !px-2 !py-1">
              +
            </button>
            <button type="button" onClick={onClose} className="btn-secondary !py-1.5 text-xs">
              Cancel
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[1fr_300px] lg:overflow-hidden">
          <div className="min-h-[60vh] overflow-auto bg-muted/40 p-4">
            {loadError ? (
              <div className="p-6 text-sm text-primary">{loadError}</div>
            ) : !pdf ? (
              <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">Rendering the document…</div>
            ) : (
              <PdfPages
                data={pdf.data}
                pages={Array.from({ length: pdf.pageCount }, () => PAGE_INFO)}
                scale={zoom}
                renderOverlay={overlay}
                onPageClick={(page, point) => addAt(page, point)}
                cursor="crosshair"
              />
            )}
          </div>

          <aside className="min-h-0 space-y-4 overflow-y-auto border-t p-4 text-xs lg:border-l lg:border-t-0">
            <div>
              <div className="eyebrow mb-2">1 · Pick who signs</div>
              <div className="space-y-1.5">
                {signers.map((s) => {
                  const c = signerColor(s.index);
                  const count = placements.filter((p) => p.signerIndex === s.index).length;
                  return (
                    <button
                      key={s.index}
                      type="button"
                      onClick={() => setActive(s.index)}
                      className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left ${active === s.index ? 'ring-2' : 'hover:bg-muted'}`}
                      style={active === s.index ? { borderColor: c.border, boxShadow: `0 0 0 2px ${c.border}55` } : undefined}
                    >
                      <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: c.bg, border: `1.5px dashed ${c.border}` }} />
                      <span className="flex-1 truncate font-medium">{s.role}</span>
                      <span className="text-muted-foreground">{count ? `${count} box${count > 1 ? 'es' : ''}` : 'not placed'}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1 text-muted-foreground">
              <div className="eyebrow mb-1 text-foreground">2 · Place and adjust</div>
              <p>Click on a page to drop a box for <strong className="text-foreground">{roleOf(active)}</strong>.</p>
              <p>Drag a box to move it. Pull its corner to resize. Select it and press Delete to remove it, or use the arrow keys to nudge.</p>
              <p>
                The signature is scaled to fit inside the box. Each box stays with the paragraph or table cell it sits in,
                so it still lines up when real names and addresses make the text longer or shorter.
              </p>
            </div>

            {placements.length > 0 && (
              <ul className="space-y-1">
                {placements.map((p, idx) => (
                  <li
                    key={idx}
                    className={`flex items-center justify-between gap-2 rounded px-1.5 py-1 ${selected === idx ? 'bg-muted' : ''}`}
                  >
                    <button type="button" onClick={() => setSelected(idx)} className="flex min-w-0 items-center gap-1.5 text-left">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: signerColor(p.signerIndex).border }} />
                      <span className="truncate">
                        {roleOf(p.signerIndex)} · page {p.page + 1}
                      </span>
                    </button>
                    <button type="button" onClick={() => removeAt(idx)} className="text-muted-foreground hover:text-primary" aria-label="Remove box">
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {missing.length > 0 && placements.length > 0 && (
              <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-900">
                Not placed: {missing.map((s) => s.role).join(', ')}. Their signature will only appear on the completion page.
              </p>
            )}

            <div className="space-y-2 border-t pt-3">
              {footer}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPlacements([]);
                    setSelected(null);
                  }}
                  disabled={placements.length === 0}
                  className="btn-secondary flex-1 !py-1.5 text-xs disabled:opacity-50"
                >
                  Clear all
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // Tie each box to the paragraph/cell it sits in, so it moves with that text.
                    onSave(placements.map((p) => anchorPlacement(p, anchors)));
                    toast.success(placements.length ? 'Signature positions saved' : 'Signature positions cleared');
                  }}
                  className="btn-primary flex-1 !py-1.5 text-xs"
                >
                  Save positions
                </button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
