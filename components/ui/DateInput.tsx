'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A date field with a calendar: click it, pick the month and year from drop-downs (or step
 * month by month), then click the day. A drop-in for <input type="date">: the value is
 * "YYYY-MM-DD" ('' when empty) and onChange receives an event-like object, so existing
 * `onChange={(e) => set(e.target.value)}` code keeps working.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const pad = (n: number) => String(n).padStart(2, '0');
const toYmd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
function parse(v: string | undefined | null): { y: number; m: number; d: number } | null {
  const x = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? '');
  return x ? { y: Number(x[1]), m: Number(x[2]) - 1, d: Number(x[3]) } : null;
}
const label = (v: string) => {
  const p = parse(v);
  return p ? `${p.d} ${MONTHS[p.m]!.slice(0, 3)} ${p.y}` : '';
};
function todayYmd() {
  const n = new Date();
  return toYmd(n.getFullYear(), n.getMonth(), n.getDate());
}

export interface DateInputProps {
  value?: string;
  onChange?: (e: { target: { value: string } }) => void;
  min?: string;
  max?: string;
  id?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  /** Show a "Clear" button (default true unless required). */
  clearable?: boolean;
  'aria-label'?: string;
  name?: string;
  title?: string;
}

export function DateInput({ value = '', onChange, min, max, id, className = '', placeholder = 'Pick a date', disabled, required, clearable, 'aria-label': ariaLabel, title }: DateInputProps) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const reactId = useId();
  const sel = parse(value);
  const now = new Date();
  const [view, setView] = useState<{ y: number; m: number }>({ y: sel?.y ?? now.getFullYear(), m: sel?.m ?? now.getMonth() });

  const minP = parse(min);
  const maxP = parse(max);
  const years = useMemo(() => {
    const from = Math.min(minP?.y ?? now.getFullYear() - 12, view.y, sel?.y ?? view.y);
    const to = Math.max(maxP?.y ?? now.getFullYear() + 3, view.y, sel?.y ?? view.y);
    return Array.from({ length: to - from + 1 }, (_, i) => to - i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max, view.y, sel?.y]);

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const w = 288;
    const h = 372;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 6;
    const top = below + h > window.innerHeight && r.top - h - 6 > 8 ? r.top - h - 6 : below;
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onScroll = (ev: Event) => { if (!pop.current?.contains(ev.target as Node)) place(); };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', onScroll, true); };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const down = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  const openIt = () => {
    if (disabled) return;
    const p = parse(value);
    setView({ y: p?.y ?? now.getFullYear(), m: p?.m ?? now.getMonth() });
    setOpen((o) => !o);
  };

  const emit = (v: string) => onChange?.({ target: { value: v } });
  const outOfRange = (ymd: string) => (min ? ymd < min : false) || (max ? ymd > max : false);
  const shift = (delta: number) => setView((v) => {
    const t = v.y * 12 + v.m + delta;
    return { y: Math.floor(t / 12), m: ((t % 12) + 12) % 12 };
  });

  // Monday-first grid of the viewed month.
  const first = new Date(view.y, view.m, 1);
  const lead = (first.getDay() + 6) % 7;
  const daysIn = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: daysIn }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const today = todayYmd();
  const canClear = clearable ?? !required;

  const nav = 'flex h-8 w-8 items-center justify-center rounded-md text-base hover:bg-elevated disabled:opacity-30';
  const sel8 = 'h-8 rounded-md border bg-card px-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/40';

  return (
    <>
      <button
        ref={btn}
        type="button"
        id={id}
        title={title}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? reactId : undefined}
        onClick={openIt}
        className={`flex min-w-[9.5rem] items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-left text-sm disabled:opacity-50 ${className}`}
      >
        <span className={value ? '' : 'text-muted-foreground'}>{value ? label(value) : placeholder}</span>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground" aria-hidden>
          <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
      </button>
      {open && pos && typeof document !== 'undefined' && createPortal(
        <div
          ref={pop}
          id={reactId}
          role="dialog"
          aria-label="Choose a date"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: 288, zIndex: 80 }}
          className="rounded-xl border bg-card p-3 shadow-xl"
        >
          <div className="mb-2 flex items-center gap-1">
            <button type="button" className={nav} onClick={() => shift(-1)} aria-label="Previous month">‹</button>
            <select aria-label="Month" value={view.m} onChange={(e) => setView((v) => ({ ...v, m: Number(e.target.value) }))} className={`${sel8} min-w-0 flex-1`}>
              {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
            </select>
            <select aria-label="Year" value={view.y} onChange={(e) => setView((v) => ({ ...v, y: Number(e.target.value) }))} className={`${sel8} w-[4.75rem]`}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <button type="button" className={nav} onClick={() => shift(1)} aria-label="Next month">›</button>
          </div>
          <div className="grid grid-cols-7 gap-y-0.5 text-center text-[11px] text-muted-foreground">
            {DAYS.map((d) => <div key={d} className="py-1 font-medium">{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-y-0.5">
            {cells.map((d, i) => {
              if (d == null) return <div key={`e${i}`} />;
              const ymd = toYmd(view.y, view.m, d);
              const isSel = value.slice(0, 10) === ymd;
              const dis = outOfRange(ymd);
              return (
                <button
                  key={ymd}
                  type="button"
                  disabled={dis}
                  onClick={() => { emit(ymd); setOpen(false); btn.current?.focus(); }}
                  aria-label={ymd}
                  aria-pressed={isSel}
                  className={`mx-auto flex h-8 w-8 items-center justify-center rounded-full text-sm tabular-nums ${isSel ? 'bg-primary font-semibold text-white' : ymd === today ? 'border border-primary text-primary hover:bg-elevated' : 'hover:bg-elevated'} disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent`}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex items-center justify-between border-t pt-2 text-xs">
            <button type="button" className="text-primary hover:underline disabled:opacity-40 disabled:no-underline" disabled={outOfRange(today)} onClick={() => { emit(today); setOpen(false); }}>Today</button>
            {canClear && value ? <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => { emit(''); setOpen(false); }}>Clear</button> : <span />}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
