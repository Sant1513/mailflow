import { normalizeFieldKey } from './fields';

/**
 * Sending for signature straight from Data: rows arrive with their dataset
 * columns, and each template field / signer is matched to a column by name.
 * Pure so the bulk-send page and tests share it.
 */

export interface SourceColumn {
  key: string;
  label: string;
}

export interface SourceRow {
  /** Null for a segment contact that has no data row (nothing to write back to). */
  recordId: string | null;
  datasetId: string | null;
  data: Record<string, string>;
}

export interface SigningSource {
  label: string;
  columns: SourceColumn[];
  rows: SourceRow[];
}

/** Column keys the bulk page fills a contact's own name/email into for segment rows. */
export const CONTACT_NAME_KEY = '__contact_name';
export const CONTACT_EMAIL_KEY = '__contact_email';

/** Columns MailFlow writes back itself; never offered as a document value. */
const WRITEBACK_KEYS = new Set([
  'signing_status',
  'signing_document',
  'signing_sent_at',
  'signed_at',
  'signed_document_url',
  'days_waiting_to_sign',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function forms(c: SourceColumn): string[] {
  return [normalizeFieldKey(c.key), normalizeFieldKey(c.label)].filter(Boolean);
}

/** Loose form: "student_name", "Student Name" and "studentname" all collapse to "studentname". */
function squash(s: string): string {
  return normalizeFieldKey(s).replace(/_/g, '');
}

/**
 * Best column for a name like "student_name": exact key/label match first,
 * then the same letters ignoring separators. Returns '' when nothing fits.
 */
export function matchColumn(target: string, columns: SourceColumn[], exclude: Set<string> = new Set()): string {
  const want = normalizeFieldKey(target);
  if (!want) return '';
  const pool = columns.filter((c) => !exclude.has(c.key) && !WRITEBACK_KEYS.has(c.key));
  const exact = pool.find((c) => forms(c).includes(want));
  if (exact) return exact.key;
  const loose = pool.find((c) => forms(c).some((f) => squash(f) === squash(want)));
  return loose?.key ?? '';
}

function share(rows: SourceRow[], key: string, test: (v: string) => boolean): number {
  const filled = rows.map((r) => (r.data[key] ?? '').trim()).filter(Boolean);
  if (!filled.length) return 0;
  return filled.filter(test).length / filled.length;
}

/** The column that holds the signer's email: named like one, and mostly holding emails. */
export function detectEmailColumn(columns: SourceColumn[], rows: SourceRow[]): string {
  const candidates = columns.filter((c) => !WRITEBACK_KEYS.has(c.key));
  const scored = candidates
    .map((c) => {
      const name = `${c.key} ${c.label}`.toLowerCase();
      const looks = share(rows, c.key, (v) => EMAIL_RE.test(v));
      let score = looks * 10;
      if (/e-?mail/.test(name)) score += 5;
      if (/personal|student|candidate|primary/.test(name)) score += 1;
      if (/manager|poc|hr|cc|alt|secondary|parent/.test(name)) score -= 2;
      if (c.key === CONTACT_EMAIL_KEY) score += 0.5;
      return { key: c.key, score, looks };
    })
    .filter((s) => s.looks >= 0.5 || (rows.length === 0 && s.score >= 5))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.key ?? '';
}

/** The column that holds the signer's full name. */
export function detectNameColumn(columns: SourceColumn[], rows: SourceRow[], emailKey = ''): string {
  const scored = columns
    .filter((c) => c.key !== emailKey && !WRITEBACK_KEYS.has(c.key))
    .map((c) => {
      const name = `${c.key} ${c.label}`.toLowerCase();
      if (!/name/.test(name) || /company|org|college|course|file|user_?name|batch|program/.test(name)) return { key: c.key, score: 0 };
      let score = 5;
      if (/full|student|candidate|learner/.test(name)) score += 2;
      if (/first|last|father|mother|parent|manager|poc/.test(name)) score -= 3;
      if (c.key === CONTACT_NAME_KEY) score += 0.5;
      // Names are words, not emails or numbers.
      score += share(rows, c.key, (v) => /[a-z]/i.test(v) && !EMAIL_RE.test(v)) * 2;
      return { key: c.key, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.key ?? '';
}

export interface DataMapping {
  nameColumn: string;
  emailColumn: string;
  /** Template field key -> column key ('' = signer fills it in). */
  fields: Record<string, string>;
  /** Signer index (2, 3) -> its name/email columns, for signers not fixed. */
  signers: Record<number, { nameColumn: string; emailColumn: string }>;
}

export function autoMapData(
  source: Pick<SigningSource, 'columns' | 'rows'>,
  fieldKeys: string[],
  extraSigners: { index: number; nameColumn: string; emailColumn: string }[],
): DataMapping {
  const { columns, rows } = source;
  const emailColumn = detectEmailColumn(columns, rows);
  const nameColumn = detectNameColumn(columns, rows, emailColumn);
  const fields: Record<string, string> = {};
  for (const key of fieldKeys) {
    const k = key.toLowerCase();
    // A template's {{name}} / {{email}} is the signer's own, so reuse those columns.
    if ((k === 'name' || k === 'full_name' || k === 'recipient_name') && nameColumn) fields[key] = matchColumn(key, columns) || nameColumn;
    else if ((k === 'email' || k === 'recipient_email') && emailColumn) fields[key] = matchColumn(key, columns) || emailColumn;
    else fields[key] = matchColumn(key, columns);
  }
  const signers: DataMapping['signers'] = {};
  for (const s of extraSigners) {
    signers[s.index] = { nameColumn: matchColumn(s.nameColumn, columns), emailColumn: matchColumn(s.emailColumn, columns) };
  }
  return { nameColumn, emailColumn, fields, signers };
}

/** Human-friendly string for any stored cell (dates, booleans, arrays). */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(cellText).filter(Boolean).join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v).trim();
  // ISO timestamps from DATE/DATETIME columns read as dd-mm-yyyy on a document.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+Z?)?$/.exec(s);
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;
  return s;
}
