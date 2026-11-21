import type { Daily } from '@/lib/loading/clean';
import { EDTECH, PAGE_LINES, THOUGHTS, WORK, type PageKey } from '@/lib/loading/lines';

/**
 * Picks what one appearance of the loading screen says. Pure (a random source and a memory are passed in) so it can be tested.
 *  - First: what the person is doing (their search, filters, selection), up to 3 lines.
 *  - Then: today's fresh AI lines for this page, this page's own lines, today's general lines, with an edtech or work line
 *    after each, all shuffled once per appearance.
 *  - It never opens with the line the previous screen opened with, nor the one this page opened with last time.
 *  - The thought avoids the last 4 shown.
 */
export interface Memory {
  /** The first line of the previous screen, on any page. */
  lastFirst: string;
  /** The first line of the last screen of each page. */
  byPage: Partial<Record<PageKey, string>>;
  /** The last few thoughts shown. */
  thoughts: string[];
}

export const emptyMemory = (): Memory => ({ lastFirst: '', byPage: {}, thoughts: [] });
export const RECENT_THOUGHTS = 4;
export const MAX_CONTEXT = 3;

export function shuffle<T>(a: readonly T[], rand: () => number = Math.random): T[] {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [x[i], x[j]] = [x[j]!, x[i]!];
  }
  return x;
}

export interface Picked { lines: string[]; thought: string }

export function pickScreen(opts: { key: PageKey; context?: string[]; daily?: Daily | null; memory: Memory; rand?: () => number }): Picked {
  const { key, memory, daily } = opts;
  const rand = opts.rand ?? Math.random;
  const fresh = shuffle(daily?.pages?.[key] ?? [], rand);
  const own = shuffle(PAGE_LINES[key], rand);
  const general = shuffle(daily?.general ?? [], rand);
  const flavour = shuffle([...EDTECH, ...WORK], rand);

  const out: string[] = [...(opts.context ?? []).filter(Boolean).slice(0, MAX_CONTEXT)];
  const seen = new Set(out);
  const base = [...fresh, ...own, ...general].filter((l) => !seen.has(l)).slice(0, 7);
  base.forEach((l, i) => {
    out.push(l);
    const f = flavour[i];
    if (f && !seen.has(f)) out.push(f);
  });

  // Never open with what the last screen (or the last screen of this page) opened with.
  for (let i = 0; i < out.length && out.length > 1 && (out[0] === memory.lastFirst || out[0] === memory.byPage[key]); i++) out.push(out.shift()!);
  memory.lastFirst = out[0] ?? '';
  memory.byPage[key] = out[0] ?? '';

  const pool = shuffle([...(daily?.thoughts ?? []), ...(daily?.thoughts ?? []), ...THOUGHTS], rand);
  const thought = pool.find((t) => !memory.thoughts.includes(t)) ?? pool[0] ?? '';
  memory.thoughts.push(thought);
  while (memory.thoughts.length > RECENT_THOUGHTS) memory.thoughts.shift();
  return { lines: out, thought };
}

/** A context line from a template and the person's own words (cut short, plain text). */
export function contextLine(template: string, value: string | null | undefined, max = 34): string | null {
  const v = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!v) return null;
  const shown = v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v;
  return template.replace('{}', shown);
}
