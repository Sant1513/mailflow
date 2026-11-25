/** Sorting for tables that are already loaded in the browser (and for in-memory rows on the server). */
export type SortDir = 'asc' | 'desc';

/** Empty values always go last, whichever way the column is sorted; text compares without case and numbers inside text compare as numbers. */
export function compareValues(a: unknown, b: unknown, dir: SortDir): number {
  const empty = (v: unknown) => v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v));
  const ea = empty(a), eb = empty(b);
  if (ea && eb) return 0;
  if (ea) return 1;
  if (eb) return -1;
  const norm = (v: unknown): number | string => (v instanceof Date ? v.getTime() : typeof v === 'boolean' ? Number(v) : typeof v === 'number' ? v : String(v));
  let x = norm(a), y = norm(b);
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(x) && typeof y === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(y)) { x = Date.parse(x); y = Date.parse(y); }
  const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { sensitivity: 'base', numeric: true });
  return dir === 'asc' ? r : -r;
}

/** A new sorted array; ties keep their original order. */
export function sortRows<T>(rows: readonly T[], pick: (row: T) => unknown, dir: SortDir): T[] {
  return rows.map((row, i) => ({ row, i })).sort((p, q) => compareValues(pick(p.row), pick(q.row), dir) || p.i - q.i).map((p) => p.row);
}

/** The next state when a header is clicked: a new column starts at its natural direction, the same column flips. */
export function nextSort<K extends string>(cur: { key: K; dir: SortDir }, key: K, first: SortDir = 'asc'): { key: K; dir: SortDir } {
  if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: first };
}
