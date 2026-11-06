import { escapeHtml } from '@/lib/templates/variables';

/**
 * Recruiter Bulk Send personalisation: {{Column}} in the subject and message takes each
 * recruiter's value from their row of the pasted/uploaded list.
 *
 *  - Names match the column header loosely: {{UTM link}}, {{utm_link}} and {{UTM Link}} are
 *    the same column. Email, Name and First name always exist (from the address and name).
 *  - {{Column | fallback}} uses the fallback when the recruiter's value is empty. With no
 *    fallback, a recruiter whose value is empty is skipped (shown at the check) rather than
 *    sent a broken email — an empty UTM link must never go out.
 *  - Values are HTML-escaped in the message. A value that is a link and sits in the text
 *    (not inside a tag or an existing link) becomes a clickable link; inside href="…" it is
 *    used exactly as given, so per-recruiter UTM links keep their parameters.
 *  - Only individual copies can be personalised: a BCC email is one message for many people.
 */

export const BUILT_IN_VARIABLES = ['Email', 'Name', 'First name'] as const;

export interface PersonRow {
  email: string;
  name: string | null;
  data?: unknown;
}

const TOKEN_RE = /\{\{\s*([^{}|]{1,80}?)\s*(?:\|\s*([^{}]{0,200}?)\s*)?\}\}/g;
const URL_RE = /^https?:\/\/[^\s<>"']+$/i;

export const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Every {{…}} in the texts, by name as written (first spelling wins), with whether it has a fallback. */
export function variablesIn(...sources: (string | null | undefined)[]): { name: string; fallback: boolean }[] {
  const out = new Map<string, { name: string; fallback: boolean }>();
  for (const source of sources) {
    if (!source) continue;
    for (const m of source.matchAll(TOKEN_RE)) {
      const key = squash(m[1]!);
      if (!key) continue;
      const prev = out.get(key);
      const fallback = m[2] !== undefined && m[2].trim() !== '';
      // A variable "has a fallback" only if every use of it has one.
      out.set(key, { name: prev?.name ?? m[1]!.trim(), fallback: prev ? prev.fallback && fallback : fallback });
    }
  }
  return [...out.values()];
}

function rowData(row: PersonRow): Record<string, string> {
  const d = row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? (row.data as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) out[k] = v == null ? '' : String(v).trim();
  return out;
}

/** The recruiter's values by squashed name: their row's columns, then the built-ins where no column has that name. */
export function valuesOf(row: PersonRow): Map<string, string> {
  const values = new Map<string, string>();
  for (const [k, v] of Object.entries(rowData(row))) if (squash(k) && !values.has(squash(k))) values.set(squash(k), v);
  const name = (row.name ?? '').trim();
  const builtIns: [string, string][] = [
    ['email', row.email],
    ['name', name],
    ['firstname', name.split(/\s+/)[0] ?? ''],
  ];
  for (const [k, v] of builtIns) if (!values.get(k)) values.set(k, v);
  return values;
}

/** Names that may be used: the list's columns plus the built-ins. */
export function knownVariables(columns: string[]): Set<string> {
  return new Set([...columns.map(squash), ...BUILT_IN_VARIABLES.map(squash)]);
}

/**
 * What the email's variables mean for this send: which are used, which match no column
 * (they would go out literally), and whether the mode can personalise at all.
 */
export function variableCheck(blast: { subject: string; html: string; mode: string; columns?: string[] | null }) {
  const used = variablesIn(blast.subject, blast.html);
  const known = knownVariables(blast.columns ?? []);
  const unknown = used.filter((v) => !known.has(squash(v.name))).map((v) => v.name);
  return { used: used.map((v) => v.name), unknown, bccConflict: blast.mode === 'BCC' && used.length > 0 };
}

/** Variables (without a fallback) this recruiter has no value for. */
export function missingValues(blast: { subject: string; html: string }, row: PersonRow): string[] {
  const values = valuesOf(row);
  return variablesIn(blast.subject, blast.html)
    .filter((v) => !v.fallback && !values.get(squash(v.name)))
    .map((v) => v.name);
}

function insideTag(html: string, index: number): boolean {
  return html.lastIndexOf('<', index) > html.lastIndexOf('>', index);
}
function insideLink(html: string, index: number): boolean {
  const before = html.slice(0, index).toLowerCase();
  return before.lastIndexOf('<a ') > before.lastIndexOf('</a>');
}

/** The email for one recruiter. `html` is the built message HTML; subject and plain text are substituted raw. */
export function personalize(content: { subject: string; html: string; plainText: string }, row: PersonRow): { subject: string; html: string; plainText: string; resolved: Record<string, string> } {
  const values = valuesOf(row);
  const resolved: Record<string, string> = {};
  const pick = (name: string, fallback: string | undefined) => {
    const v = values.get(squash(name));
    if (!values.has(squash(name))) return null; // not a variable we know: leave it as written
    const value = v || (fallback ?? '').trim();
    resolved[name.trim()] = value;
    return value;
  };
  const raw = (text: string) =>
    text.replace(TOKEN_RE, (whole, name: string, fallback?: string) => {
      const v = pick(name, fallback);
      return v === null ? whole : v;
    });
  const html = content.html.replace(TOKEN_RE, (whole, name: string, fallback: string | undefined, offset: number, source: string) => {
    const has = values.get(squash(name));
    const v = pick(name, fallback);
    if (v === null) return whole;
    // The fallback was typed into the HTML already, so it is not escaped again.
    if (!has) return v;
    if (insideTag(source, offset)) return escapeHtml(v);
    if (URL_RE.test(v) && !insideLink(source, offset)) return `<a href="${escapeHtml(v)}">${escapeHtml(v)}</a>`;
    return escapeHtml(v);
  });
  return { subject: raw(content.subject), html, plainText: raw(content.plainText), resolved };
}
