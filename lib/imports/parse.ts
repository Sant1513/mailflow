import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { ColumnType } from '@prisma/client';

export interface ParsedTable {
  headers: string[];
  rows: Record<string, string>[];
}

/** Parses pasted TSV/CSV text (from Google Sheets / Excel copy-paste). */
export function parsePastedText(text: string): ParsedTable {
  const delimiter = text.includes('\t') ? '\t' : ',';
  const result = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    delimiter,
    skipEmptyLines: true,
  });
  const headers = result.meta.fields ?? [];
  return { headers, rows: result.data };
}

export function parseCsvFile(buffer: Buffer): ParsedTable {
  const result = Papa.parse<Record<string, string>>(buffer.toString('utf8'), {
    header: true,
    skipEmptyLines: true,
  });
  return { headers: result.meta.fields ?? [], rows: result.data };
}

export function parseXlsxFile(buffer: Buffer): ParsedTable {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return { headers: [], rows: [] };
  const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const firstRow = rows[0];
  const headers = firstRow ? Object.keys(firstRow) : [];
  return { headers, rows };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/** Best-effort type inference per column, sampling up to 50 rows (§15). */
export function inferColumnTypes(table: ParsedTable): Record<string, ColumnType> {
  const sample = table.rows.slice(0, 50);
  const types: Record<string, ColumnType> = {};
  for (const header of table.headers) {
    const values = sample.map((r) => (r[header] ?? '').trim()).filter(Boolean);
    if (values.length === 0) {
      types[header] = ColumnType.TEXT;
      continue;
    }
    if (values.every((v) => EMAIL_RE.test(v))) {
      types[header] = ColumnType.EMAIL;
    } else if (values.every((v) => DATE_RE.test(v))) {
      types[header] = ColumnType.DATE;
    } else if (values.every((v) => !Number.isNaN(Number(v)))) {
      types[header] = ColumnType.NUMBER;
    } else if (values.every((v) => ['true', 'false', '0', '1', 'yes', 'no'].includes(v.toLowerCase()))) {
      types[header] = ColumnType.CHECKBOX;
    } else {
      types[header] = ColumnType.TEXT;
    }
  }
  return types;
}

export function guessEmailColumn(headers: string[]): string | null {
  const byName = headers.find((h) => /^e-?mail$/i.test(h.trim()));
  if (byName) return byName;
  const contains = headers.find((h) => /email/i.test(h));
  return contains ?? null;
}

export interface DuplicateAnalysis {
  uniqueEmails: number;
  duplicateRows: number;
  duplicateGroups: Record<string, number[]>; // email -> row indexes
}

export function analyzeDuplicates(table: ParsedTable, emailColumn: string): DuplicateAnalysis {
  const seen = new Map<string, number[]>();
  table.rows.forEach((row, idx) => {
    const email = (row[emailColumn] ?? '').trim().toLowerCase();
    if (!email) return;
    const list = seen.get(email) ?? [];
    list.push(idx);
    seen.set(email, list);
  });
  let duplicateRows = 0;
  const duplicateGroups: Record<string, number[]> = {};
  for (const [email, idxs] of seen.entries()) {
    if (idxs.length > 1) {
      duplicateRows += idxs.length - 1;
      duplicateGroups[email] = idxs;
    }
  }
  return { uniqueEmails: seen.size, duplicateRows, duplicateGroups };
}
