/**
 * Template variable engine (§24/§25).
 *
 * Variables are written `{{Name}}`. Rules that matter:
 *  - A variable referenced by a template but absent from the dataset BLOCKS
 *    the send (§24) — `validateVariables` is what campaign validation calls.
 *  - Values are HTML-escaped when substituted into the HTML body, so a
 *    student's name containing `<` can never inject markup into the email
 *    (or into our own preview).
 *  - Rendering is pure and deterministic: same template version + same
 *    record data always produces byte-identical output, which is what makes
 *    the immutable send snapshot in §89 meaningful.
 */

/** Matches {{ VariableName }} with optional surrounding whitespace. */
const VARIABLE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function extractVariables(...sources: (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(VARIABLE_RE)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return Array.from(found).sort();
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stringifyValue(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

export interface RenderResult {
  subject: string;
  html: string;
  plainText: string | null;
  /** Variables the template referenced that had no value in the data. */
  missingVariables: string[];
  /** Resolved values actually substituted, for the "preview as" panel (§25). */
  resolved: Record<string, string>;
}

export function renderTemplate(
  template: { subject: string; html: string; plainText?: string | null },
  data: Record<string, unknown>
): RenderResult {
  const missing = new Set<string>();
  const resolved: Record<string, string> = {};

  const substitute = (source: string, escape: boolean): string =>
    source.replace(VARIABLE_RE, (_full, name: string) => {
      const has = Object.prototype.hasOwnProperty.call(data, name);
      const raw = has ? stringifyValue(data[name]) : '';
      if (!has || raw === '') missing.add(name);
      resolved[name] = raw;
      return escape ? escapeHtml(raw) : raw;
    });

  return {
    // Subject is a plain-text header — escaping it would leak literal
    // "&amp;" into inboxes, so it is substituted raw.
    subject: substitute(template.subject, false),
    html: substitute(template.html, true),
    plainText: template.plainText ? substitute(template.plainText, false) : null,
    missingVariables: Array.from(missing).sort(),
    resolved,
  };
}

export interface VariableValidation {
  ok: boolean;
  /** Referenced by the template but not present as a dataset column. */
  missing: string[];
  /** Available as a column but never referenced — informational only. */
  unused: string[];
  used: string[];
}

export function validateVariables(
  template: { subject: string; html: string; plainText?: string | null },
  availableKeys: string[]
): VariableValidation {
  const used = extractVariables(template.subject, template.html, template.plainText);
  const available = new Set(availableKeys);
  const missing = used.filter((v) => !available.has(v));
  const unused = availableKeys.filter((k) => !used.includes(k));
  return { ok: missing.length === 0, missing, unused, used };
}

/** Strips tags to build a plain-text fallback body from the HTML (§20). */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    // Paragraphs and headings get a blank line between them; other blocks
    // just break the line. Reads far better as a plain-text alternative.
    .replace(/<\/(p|h[1-6])>/gi, '\n\n')
    .replace(/<\/(div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
