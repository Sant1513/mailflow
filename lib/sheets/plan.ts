import { normalizeFieldKey } from '@/lib/signing/fields';

/**
 * Two-way Google Sheets sync, planned as pure data so it can be tested
 * without Google or a database. Rows are matched by a key column (usually
 * email). For each matched cell:
 *   - MailFlow-owned columns (signing status, signed date, document link)
 *     always flow MailFlow → sheet;
 *   - a cell edited in MailFlow since the last sync flows MailFlow → sheet;
 *   - otherwise the sheet wins (sheet → MailFlow).
 * Sheet rows with a new key become records; records created in MailFlow
 * after the sheet was connected are appended to the sheet. Nothing is ever
 * deleted on either side.
 */

export interface PlanColumn {
  key: string;
  label: string;
  type: string;
}

export interface PlanRecord {
  id: string;
  data: Record<string, unknown>;
  createdAt: Date;
}

export interface OwnedColumn {
  key: string;
  label: string;
}

export interface SyncPlanInput {
  /** values[0] is the header row. */
  values: string[][];
  columns: PlanColumn[];
  records: PlanRecord[];
  keyHeader: string;
  owned: OwnedColumn[];
  /** recordId -> fields changed in MailFlow (not by this sync) since the last sync. */
  editedSince: Map<string, Set<string>>;
  connectedAt: Date;
  /** Formats a MailFlow value for the sheet. */
  display?: (v: unknown, key: string) => string;
}

export interface CellWrite {
  /** 0-based row in the sheet (0 = header row). */
  row: number;
  /** 0-based column in the sheet. */
  col: number;
  value: string;
}

export interface SyncPlan {
  error?: string;
  newColumns: PlanColumn[];
  recordUpdates: { recordId: string; fields: Record<string, unknown> }[];
  recordCreates: { data: Record<string, unknown> }[];
  cellWrites: CellWrite[];
  appendRows: string[][];
  duplicateKeys: number;
  skippedNoKey: number;
}

export function normKey(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

export function defaultDisplay(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => defaultDisplay(x)).filter(Boolean).join(', ');
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v).trim();
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A1 range for a sheet name that may contain spaces or quotes. */
export function quoteSheet(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

export function spreadsheetIdFromUrl(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{25,}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname !== 'docs.google.com') return null;
    const m = /\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{25,})/.exec(u.pathname);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** Sheet header -> dataset column key; new columns for headers the dataset lacks. */
export function mapHeaders(headers: string[], columns: PlanColumn[]): { keys: (string | null)[]; newColumns: PlanColumn[] } {
  const used = new Set(columns.map((c) => c.key));
  const claimed = new Set<string>();
  const newColumns: PlanColumn[] = [];
  const keys = headers.map((raw, i) => {
    const h = (raw ?? '').trim();
    if (!h) return null;
    const want = normalizeFieldKey(h);
    const existing = columns.find(
      (c) => !claimed.has(c.key) && (normalizeFieldKey(c.label) === want || c.key === want),
    );
    if (existing) {
      claimed.add(existing.key);
      return existing.key;
    }
    let key = want && /^[a-z]/.test(want) ? want : `column_${i + 1}`;
    for (let n = 2; used.has(key); n++) key = `${want || `column_${i + 1}`}_${n}`;
    used.add(key);
    claimed.add(key);
    newColumns.push({ key, label: h, type: 'TEXT' });
    return key;
  });
  return { keys, newColumns };
}

export function planSync(input: SyncPlanInput): SyncPlan {
  const display = input.display ?? ((v: unknown) => defaultDisplay(v));
  const plan: SyncPlan = { newColumns: [], recordUpdates: [], recordCreates: [], cellWrites: [], appendRows: [], duplicateKeys: 0, skippedNoKey: 0 };
  const headers = (input.values[0] ?? []).map((h) => String(h ?? ''));
  if (!headers.some((h) => h.trim())) return { ...plan, error: 'The sheet has no header row (row 1 is empty).' };

  const { keys, newColumns } = mapHeaders(headers, input.columns);
  plan.newColumns = newColumns;
  const keyIdx = headers.findIndex((h) => normalizeFieldKey(h) === normalizeFieldKey(input.keyHeader));
  if (keyIdx < 0) return { ...plan, error: `The sheet has no "${input.keyHeader}" column to match rows by.` };
  const keyCol = keys[keyIdx]!;
  const types = new Map([...input.columns, ...newColumns].map((c) => [c.key, c.type]));
  const ownedKeys = new Set(input.owned.map((o) => o.key));

  // Owned columns get a header only once a record actually has a value for them.
  const colOf = new Map<string, number>();
  keys.forEach((k, i) => {
    if (k && !colOf.has(k)) colOf.set(k, i);
  });
  let nextCol = headers.length;
  const recordsWithOwned = (key: string) => input.records.some((r) => display(r.data[key], key) !== '');
  for (const o of input.owned) {
    if (colOf.has(o.key) || !recordsWithOwned(o.key)) continue;
    colOf.set(o.key, nextCol);
    plan.cellWrites.push({ row: 0, col: nextCol, value: o.label });
    nextCol++;
  }

  const byKey = new Map<string, PlanRecord>();
  for (const r of input.records) {
    const k = normKey(r.data[keyCol]);
    if (k && !byKey.has(k)) byKey.set(k, r);
  }

  const toValue = (key: string, s: string): unknown => {
    if (s === '') return null;
    if (types.get(key) === 'NUMBER') {
      const n = Number(s.replace(/,/g, ''));
      if (Number.isFinite(n)) return n;
    }
    return s;
  };

  const seenKeys = new Set<string>();
  for (let row = 1; row < input.values.length; row++) {
    const cells = input.values[row] ?? [];
    const k = normKey(cells[keyIdx]);
    if (!k) {
      if (cells.some((c) => String(c ?? '').trim())) plan.skippedNoKey++;
      continue;
    }
    if (seenKeys.has(k)) {
      plan.duplicateKeys++;
      continue;
    }
    seenKeys.add(k);
    const record = byKey.get(k);

    if (!record) {
      const data: Record<string, unknown> = {};
      keys.forEach((key, col) => {
        if (!key || ownedKeys.has(key)) return;
        const v = toValue(key, String(cells[col] ?? '').trim());
        if (v !== null) data[key] = v;
      });
      plan.recordCreates.push({ data });
      continue;
    }

    const edited = input.editedSince.get(record.id) ?? new Set<string>();
    const fields: Record<string, unknown> = {};
    keys.forEach((key, col) => {
      if (!key || ownedKeys.has(key) || colOf.get(key) !== col) return;
      const sheetVal = String(cells[col] ?? '').trim();
      const mfVal = display(record.data[key], key);
      if (sheetVal === mfVal) return;
      if (edited.has(key)) plan.cellWrites.push({ row, col, value: mfVal });
      else if (!(sheetVal === '' && mfVal === '')) fields[key] = toValue(key, sheetVal);
    });
    if (Object.keys(fields).length) plan.recordUpdates.push({ recordId: record.id, fields });

    for (const o of input.owned) {
      const col = colOf.get(o.key);
      if (col === undefined) continue;
      const mfVal = display(record.data[o.key], o.key);
      if (String(cells[col] ?? '').trim() !== mfVal) plan.cellWrites.push({ row, col, value: mfVal });
    }
  }

  // Rows added in MailFlow after the sheet was connected go to the sheet.
  for (const r of input.records) {
    const k = normKey(r.data[keyCol]);
    if (!k || seenKeys.has(k) || r.createdAt <= input.connectedAt) continue;
    seenKeys.add(k);
    const out: string[] = Array.from({ length: nextCol }, () => '');
    for (const [key, col] of colOf) out[col] = display(r.data[key], key);
    plan.appendRows.push(out);
  }

  return plan;
}
