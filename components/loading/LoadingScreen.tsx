'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { dayKey, sanitizeDaily, type Daily } from '@/lib/loading/clean';
import { PAGE_LABEL, pageKeyOf, type PageKey } from '@/lib/loading/lines';
import { emptyMemory, pickScreen, type Memory, type Picked } from '@/lib/loading/pick';

/**
 * The loading screen: a ring that fills with a percentage, a line that changes every few seconds, a thought, and the page's name.
 *  - The percentage is an honest estimate, not a byte count: it rises fast, slows down near the end, never passes ~94% while
 *    waiting, and jumps to 100% the moment the page is ready (useFinishing keeps the screen up a moment so you see it).
 *  - The lines follow WHERE you are (each page has its own set) and WHAT you are doing (your search, filters or selection become
 *    the first lines), mixed with edtech and work humour. Each appearance is shuffled and never opens with the same line twice
 *    in a row (lib/loading/pick.ts). All words live in lib/loading/lines.ts.
 *  - Once a day the server can add fresh AI-written lines (lib/loading/daily.ts); they are kept for the day in this browser.
 * Everything is shown as plain text.
 */

const DAILY_KEY = 'mailflow.loadingLines';
const MEMORY_KEY = 'mailflow.loadingMemory';
const EMPTY_RETRY_MS = 30 * 60_000;
const HANDOFF_MS = 1500;
const LINE_MS = 2600;

/* ---------- today's fresh lines: asked for once a day, kept in this browser ---------- */

function readDaily(): Daily | null {
  try {
    const stored = JSON.parse(localStorage.getItem(DAILY_KEY) || 'null') as { date?: string; data?: unknown } | null;
    const d = sanitizeDaily(stored?.data); // the browser's copy is untrusted too
    return d && d.date === dayKey() ? d : null;
  } catch {
    return null;
  }
}

let asking = false;
/** Fetches today's fresh lines once (quietly: no AI, no network or no sign-in just means the built-in lines are used). */
export function ensureDailyLines(): void {
  try {
    if (asking || readDaily()) return;
    const mark = JSON.parse(localStorage.getItem(DAILY_KEY) || 'null') as { date?: string; empty?: boolean; at?: number } | null;
    if (mark?.empty && mark.date === dayKey() && Date.now() - (mark.at ?? 0) < EMPTY_RETRY_MS) return;
    asking = true;
    fetch('/api/loading-lines', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const d = sanitizeDaily(j);
        localStorage.setItem(DAILY_KEY, JSON.stringify(d && d.date === dayKey() ? { date: d.date, data: d } : { date: dayKey(), empty: true, at: Date.now() }));
      })
      .catch(() => undefined)
      .finally(() => { asking = false; });
  } catch { /* storage unavailable: built-in lines only */ }
}

/* ---------- what was shown before, so two screens in a row never open the same way ---------- */

let memory: Memory | null = null;
function theMemory(): Memory {
  if (memory) return memory;
  try {
    const m = JSON.parse(sessionStorage.getItem(MEMORY_KEY) || 'null') as Memory | null;
    memory = m && typeof m.lastFirst === 'string' && Array.isArray(m.thoughts) && m.byPage ? m : emptyMemory();
  } catch {
    memory = emptyMemory();
  }
  return memory;
}
function saveMemory() {
  try { sessionStorage.setItem(MEMORY_KEY, JSON.stringify(memory)); } catch { /* private mode */ }
}

/** A screen that was replaced by another while still loading (the route's own screen, then the page's) keeps going, so the ring and words do not restart. */
let carry: { key: PageKey; at: number; pct: number; line: number; picked: Picked } | null = null;

/** Keeps a loading screen up for a moment after the work finishes, so the ring can reach 100% instead of vanishing at 63%. */
export function useFinishing(loading: boolean, ms = 500): boolean {
  const [show, setShow] = useState(loading);
  useEffect(() => {
    if (loading) { setShow(true); return; }
    const t = setTimeout(() => setShow(false), ms);
    return () => clearTimeout(t);
  }, [loading, ms]);
  return show;
}

/** Shows the loading screen while `loading`, then the page. `context` are lines about what the person is doing. */
export function LoadGate({ loading, context, label, fullScreen = false, page, children }: { loading: boolean; context?: (string | null | undefined)[]; label?: string; fullScreen?: boolean; page?: PageKey; children: React.ReactNode }) {
  const show = useFinishing(loading);
  if (show) return <LoadingScreen done={!loading} context={context} label={label} fullScreen={fullScreen} page={page} />;
  return <>{children}</>;
}

export function LoadingScreen({ done = false, fullScreen = false, label = 'Loading', context = [], page }: { done?: boolean; fullScreen?: boolean; label?: string; context?: (string | null | undefined)[]; page?: PageKey }) {
  const pathname = usePathname() ?? '/';
  const key: PageKey = page ?? pageKeyOf(pathname);
  const doneRef = useRef(done);
  doneRef.current = done;

  // The words are chosen in the browser, once per appearance, after the screen is on the page. (Choosing while rendering would use
  // different random lines on the server and in the browser, and React would report a mismatch.) The ring, the percentage and the page
  // name are the same on both, so the screen is never blank; the line and thought appear a moment later.
  const [picked, setPicked] = useState<Picked | null>(null);
  const [pct, setPct] = useState(3);
  const [line, setLine] = useState(0);
  const live = useRef({ pct: 3, line: 0, picked: null as Picked | null });
  const chosen = useRef(false);

  useEffect(() => {
    if (chosen.current) return; // once per appearance (development runs effects twice)
    chosen.current = true;
    // A screen that was replaced by this one while still loading (the route's own screen, then the page's) keeps going.
    const taken = carry && carry.key === key && Date.now() - carry.at < HANDOFF_MS ? carry : null;
    carry = null;
    const next = taken
      ? { picked: taken.picked, pct: taken.pct, line: taken.line }
      : { picked: pickScreen({ key, context: context.filter((c): c is string => !!c), daily: readDaily(), memory: theMemory() }), pct: 3, line: 0 };
    if (!taken) saveMemory();
    live.current = { pct: next.pct, line: next.line, picked: next.picked };
    setPicked(next.picked);
    setPct((p) => Math.max(p, next.pct));
    setLine(next.line);
    ensureDailyLines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      setPct((p) => {
        // Quick at first, then slower and slower, never quite reaching the end until the page is ready.
        const next = doneRef.current ? Math.min(100, p + Math.max(8, (100 - p) * 0.6)) : Math.min(94, p + Math.max(0.15, (94 - p) * 0.045));
        live.current.pct = next;
        return next;
      });
    }, 100);
    return () => clearInterval(t);
  }, []);
  const count = picked?.lines.length ?? 0;
  useEffect(() => {
    if (count < 2) return;
    const t = setInterval(() => setLine((l) => { const n = (l + 1) % count; live.current.line = n; return n; }), LINE_MS);
    return () => clearInterval(t);
  }, [count]);
  // Leaving while still loading (another loading screen is about to appear) hands the state over.
  useEffect(() => () => {
    if (!doneRef.current && live.current.picked) carry = { key, at: Date.now(), pct: live.current.pct, line: live.current.line, picked: live.current.picked };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = Math.round(pct);
  const R = 52;
  const C = 2 * Math.PI * R;
  return (
    <div className={`${fullScreen ? 'min-h-screen' : 'min-h-[70vh]'} flex flex-col items-center justify-center gap-6 px-6 py-10 text-center`} role="status" aria-live="polite" data-loading-screen data-page={key}>
      <div className="relative h-36 w-36" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown} aria-label={label}>
        <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" aria-hidden="true">
          <circle cx="60" cy="60" r={R} fill="none" stroke="hsl(var(--border))" strokeWidth="8" />
          <circle cx="60" cy="60" r={R} fill="none" stroke="hsl(var(--primary))" strokeWidth="8" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} className="loading-ring" />
        </svg>
        <div className="absolute inset-0 grid place-items-center">
          <div><span className="text-3xl font-bold tabular-nums text-foreground" data-loading-pct>{shown}</span><span className="text-lg font-semibold text-faint">%</span></div>
        </div>
      </div>
      <div className="min-h-[3.5rem] w-full max-w-md">
        <p key={line} className="loading-msg break-words text-base font-medium text-foreground" data-loading-line aria-hidden="true">{picked?.lines[line] ?? ''}</p>
        <span className="sr-only">{label} {Math.floor(shown / 25) * 25}%</span>
      </div>
      <div className="w-full max-w-sm border-t border-border pt-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-faint" data-loading-footer>While you wait · {PAGE_LABEL[key]}</div>
        <p className="mt-1 min-h-[1.25rem] break-words text-sm italic text-muted-foreground">{picked ? `“${picked.thought}”` : ''}</p>
      </div>
    </div>
  );
}
