import { ColumnType } from '@prisma/client';
import { guessEmailColumn, inferColumnTypes } from '@/lib/imports/parse';
import { escapeHtml } from '@/lib/templates/variables';

/**
 * Quick Send: one screen that turns a pasted list / uploaded file / existing
 * dataset plus a message into a normal campaign. These helpers are pure so
 * the screen's preview and the server agree.
 */

export interface QuickColumn {
  /** Original header as the person typed it ("First Name"). */
  header: string;
  /** Key used in Record.data and {{variables}} ("First_Name"). */
  key: string;
  label: string;
  type: ColumnType;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function headerToKey(header: string, index: number): string {
  let key = header.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!key || !/^[A-Za-z]/.test(key)) key = `col_${key || index + 1}`;
  return key.slice(0, 60);
}

/** Columns for a pasted / uploaded table: unique keys, inferred types, the email column typed EMAIL. */
export function columnsFromTable(table: { headers: string[]; rows: Record<string, string>[] }, emailHeader?: string | null): QuickColumn[] {
  const types = inferColumnTypes(table);
  // The email column: as chosen, else by name ("Email"), else the first column holding only addresses ("Mail ID").
  const email = emailHeader ?? guessEmailColumn(table.headers) ?? table.headers.find((h) => types[h] === ColumnType.EMAIL) ?? null;
  const used = new Set<string>();
  return table.headers.map((header, i) => {
    let key = headerToKey(header, i);
    for (let n = 2; used.has(key.toLowerCase()); n++) key = `${headerToKey(header, i)}_${n}`;
    used.add(key.toLowerCase());
    return { header, key, label: header.trim() || key, type: header === email ? ColumnType.EMAIL : types[header] === ColumnType.EMAIL ? ColumnType.TEXT : types[header] ?? ColumnType.TEXT };
  });
}

export { normalizePastedList } from './paste';

/**
 * Lets people write {{First Name}} (the header as they see it): every
 * {{ … }} that names a column by header, label or key (any case/spacing)
 * becomes {{key}}. Unknown names are left as written, so they show as missing.
 */
export function normalizeVariables(text: string, columns: { key: string; label: string; header?: string }[]): string {
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const byName = new Map<string, string>();
  for (const c of columns) {
    for (const n of [c.key, c.label, c.header ?? '']) if (n) byName.set(squash(n), c.key);
  }
  return text.replace(/\{\{\s*([^{}]{1,80}?)\s*\}\}/g, (whole, name: string) => {
    const key = byName.get(squash(name));
    return key ? `{{${key}}}` : whole;
  });
}

/** Plain text as typed in the message box → simple email HTML (paragraphs, line breaks). */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}
