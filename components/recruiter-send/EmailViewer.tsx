'use client';

import { useEffect, useRef, useState } from 'react';
import { EmailPreview } from '@/components/email-preview/EmailPreview';

type PreviewMode = 'desktop' | 'mobile';
const PRESET_WIDTH: Record<PreviewMode, number> = { desktop: 700, mobile: 375 };

/**
 * The email in a frame you can size: Desktop / Phone presets, a width slider, and a drag handle
 * (bottom edge) for the height. Remembers the size per viewer (this browser only).
 */
export function EmailViewer({ html, storageKey, defaultHeight = 520, header, empty, fill }: { fill?: boolean; html: string; storageKey: string; defaultHeight?: number; header?: React.ReactNode; empty?: string }) {
  const [mode, setMode] = useState<PreviewMode>('desktop');
  const [width, setWidth] = useState<number>(PRESET_WIDTH.desktop);
  const [height, setHeight] = useState<number>(defaultHeight);
  const frame = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`email-viewer:${storageKey}`) ?? 'null') as { width?: number; height?: number; mode?: PreviewMode } | null;
      if (saved?.mode) setMode(saved.mode);
      if (saved?.width) setWidth(saved.width);
      if (saved?.height) setHeight(saved.height);
    } catch {
      /* private window or blocked storage: defaults are fine */
    }
  }, [storageKey]);
  useEffect(() => {
    try {
      localStorage.setItem(`email-viewer:${storageKey}`, JSON.stringify({ width, height, mode }));
    } catch {
      /* ignore */
    }
  }, [storageKey, width, height, mode]);

  // The frame's bottom edge can be dragged (CSS resize); follow it.
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const h = Math.round(el.clientHeight);
      if (h > 0) setHeight((prev) => (Math.abs(prev - h) > 2 ? h : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pick = (m: PreviewMode) => {
    setMode(m);
    setWidth(PRESET_WIDTH[m]);
  };

  return (
    <div className={`flex min-w-0 flex-col ${fill ? 'h-full min-h-0 flex-1' : ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">{header}</div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex shrink-0 rounded-full border p-0.5 text-[11px]" role="group" aria-label="Preview size">
            {(['desktop', 'mobile'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m && width === PRESET_WIDTH[m]} onClick={() => pick(m)} className={`rounded-full px-2 py-0.5 ${mode === m && width === PRESET_WIDTH[m] ? 'bg-foreground text-background' : 'text-muted-foreground'}`}>
                {m === 'desktop' ? 'Desktop' : 'Phone'}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            Width
            <input type="range" min={320} max={1000} step={10} value={width} onChange={(e) => setWidth(Number(e.target.value))} className="w-20 sm:w-24" aria-label="Preview width" />
            <span className="w-10 tabular-nums">{width}px</span>
          </label>
          <button type="button" onClick={() => { pick('desktop'); setHeight(defaultHeight); }} className="text-[11px] text-primary hover:underline">Reset</button>
        </div>
      </div>
      <div ref={frame} className={`overflow-auto ${fill ? 'min-h-[360px] flex-1' : ''}`} style={fill ? undefined : { height, minHeight: 260, maxHeight: 1600, resize: 'vertical' }} title={fill ? undefined : 'Drag the bottom edge to make the preview taller or shorter'}>
        {html ? <EmailPreview html={html} mode={mode} width={width} height={Math.max(220, height - 40)} /> : <p className="p-6 text-center text-sm text-muted-foreground">{empty ?? 'Nothing to preview yet.'}</p>}
      </div>
      {!fill && <div className="border-t px-3 py-1 text-center text-[10px] text-muted-foreground">⇕ drag the edge above to resize</div>}
    </div>
  );
}
