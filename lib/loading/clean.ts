import { PAGE_KEYS, type PageKey } from '@/lib/loading/lines';

/**
 * Loading-screen lines that did not come from lines.ts (the AI's daily batch, or what the browser kept) are
 * treated as untrusted text: tags and control characters stripped, anything long, with a link, an "@" or
 * "javascript:" dropped, non-strings and repeats dropped, counts capped. They are only ever shown as plain text.
 */
export const MAX_LINE = 90;
/** Web addresses, scripts, mentions and the like. Checked on the original text and on the cleaned text. */
const LINKISH = /https?:|ftp:|www\.|\/\/|javascript:|vbscript:|data:|@|\b[a-z0-9-]+\.(com|in|org|net|io|ai|co|edu|gov|app|dev|me|ly|xyz|info|biz)\b/i;
// Control characters, zero-width and direction-changing characters (they can hide or reorder text), as code point ranges.
const INVISIBLE: [number, number][] = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]];
function stripInvisible(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += INVISIBLE.some(([a, b]) => c >= a && c <= b) ? ' ' : ch;
  }
  return out;
}

export function cleanLine(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 600) return null;
  if (LINKISH.test(v)) return null;
  const s = stripInvisible(v.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > MAX_LINE || LINKISH.test(s)) return null;
  return s;
}

/** The clean, unique lines of `v` (anything that is not an array gives none), at most `max`. */
export function cleanLines(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    const line = cleanLine(item);
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/** One day's fresh lines. */
export interface Daily {
  date: string;
  pages: Partial<Record<PageKey, string[]>>;
  general: string[];
  thoughts: string[];
}

export const PAGE_CAP = 12;
export const GENERAL_CAP = 14;
export const THOUGHT_CAP = 24;

/** Cleans anything claiming to be a day's lines; null when it holds nothing usable or has no valid date. */
export function sanitizeDaily(raw: unknown): Daily | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const date = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null;
  if (!date) return null;
  const src = r.pages && typeof r.pages === 'object' ? (r.pages as Record<string, unknown>) : {};
  const pages: Partial<Record<PageKey, string[]>> = {};
  for (const k of PAGE_KEYS) {
    if (k === 'general') continue;
    const lines = cleanLines(src[k], PAGE_CAP);
    if (lines.length) pages[k] = lines;
  }
  const general = cleanLines(r.general ?? src.general, GENERAL_CAP);
  const thoughts = cleanLines(r.thoughts, THOUGHT_CAP);
  if (!Object.keys(pages).length && !general.length && !thoughts.length) return null;
  return { date, pages, general, thoughts };
}

/** The model's answer ({ inbox: [...], general: [...], thoughts: [...] }) in the shape sanitizeDaily takes, cleaned. */
export function dailyFromModel(answer: unknown, date: string): Daily | null {
  if (!answer || typeof answer !== 'object') return null;
  const a = answer as Record<string, unknown>;
  const pages: Record<string, unknown> = {};
  for (const k of PAGE_KEYS) if (k !== 'general') pages[k] = a[k];
  return sanitizeDaily({ date, pages, general: a.general, thoughts: a.thoughts });
}

/** The date key everyone shares: today in India (the team's working day). */
export function dayKey(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}
