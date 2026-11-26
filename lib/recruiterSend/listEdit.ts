import { isValidEmail } from '@/lib/quickSend/prepare';
import { emailKey } from '@/lib/recruiterSend/emailKey';

/** Editing a draft's recruiter list by hand (Preview list → edit / add / delete). Pure helpers; the routes do the database part. */

export const MAX_RECIPIENTS = 20_000;
export const MAX_ROWS_PER_ADD = 1000;
/** Deleted rows are handed back for "Undo" up to this many. */
export const MAX_UNDO = 2000;
export const NAME_HEADER = /^(full ?)?name$|recruiter|contact name|^poc/i;

/** "Asha <asha@acme.com>", " ASHA@acme.com " → "asha@acme.com"; null when there is no address in it. */
export function cleanEmail(input: string | null | undefined): string | null {
  const text = String(input ?? '').trim();
  const m = text.match(/[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const email = (m?.[0] ?? text).toLowerCase();
  return isValidEmail(email) ? email : null;
}

export interface RowInput { email: string; name?: string | null; data?: Record<string, unknown> }
export interface BuiltRow { email: string; name: string | null; data: Record<string, string> | null }

/**
 * One recruiter ready to store. With columns, the whole row is kept ({ column: value }), the address goes into the address
 * column and the name is read from the name column; without columns (a plain list) only address and name are kept.
 */
export function buildRow(input: RowInput, columns: string[], emailColumn: string | null): BuiltRow | { error: string } {
  const email = cleanEmail(input.email);
  if (!email) return { error: 'That is not a valid email address.' };
  if (!columns.length) return { email, name: (input.name ?? '').toString().trim().slice(0, 120) || null, data: null };
  const data: Record<string, string> = {};
  for (const c of columns) data[c] = String(input.data?.[c] ?? '').trim().slice(0, 2000);
  if (emailColumn && columns.includes(emailColumn)) data[emailColumn] = email;
  const nameHeader = columns.find((h) => h !== emailColumn && NAME_HEADER.test(h)) ?? null;
  return { email, name: nameHeader ? data[nameHeader] || null : null, data };
}

/** Sort keys the table may ask for. */
export const LIST_SORTS = ['order', 'email', 'name', 'status'] as const;
export type ListSort = (typeof LIST_SORTS)[number];

export function parseListSort(sort: string | null, dir: string | null): { sort: ListSort; dir: 'asc' | 'desc' } {
  const s = (LIST_SORTS as readonly string[]).includes(sort ?? '') ? (sort as ListSort) : 'order';
  return { sort: s, dir: dir === 'desc' ? 'desc' : 'asc' };
}

export function listOrderBy(sort: ListSort, dir: 'asc' | 'desc') {
  // `id` keeps the order of the sheet and breaks ties, so paging stays stable.
  if (sort === 'order') return [{ id: dir }];
  return [{ [sort]: dir }, { id: 'asc' as const }];
}

/** Domains as typed or ticked ("@Acme.com ", "acme.com") → lower-case bare domains, at most 200. */
export function cleanDomains(input: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  const out = new Set<string>();
  for (const d of list) {
    const v = String(d).trim().toLowerCase().replace(/^@/, '');
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) out.add(v);
  }
  return [...out].slice(0, 200);
}

/** Database condition: the address ends with @one of the domains (case-insensitive). No domains = no condition. */
export function domainsWhere(domains: string[]) {
  return domains.length ? { OR: domains.map((d) => ({ email: { endsWith: `@${d}`, mode: 'insensitive' as const } })) } : {};
}

/** Which of these addresses are the same inbox as one already taken, or as an earlier one in the list. */
export function splitDuplicates<T extends { email: string }>(rows: T[], takenKeys: Set<string>): { fresh: T[]; duplicates: T[] } {
  const seen = new Set(takenKeys);
  const fresh: T[] = [];
  const duplicates: T[] = [];
  for (const r of rows) {
    const k = emailKey(r.email);
    if (seen.has(k)) duplicates.push(r);
    else { seen.add(k); fresh.push(r); }
  }
  return { fresh, duplicates };
}
