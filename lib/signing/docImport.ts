import { normalizeFieldKey } from './fields';

/**
 * Turning a Word / Google Doc into a signing template. Word splits text into
 * runs, so "{{student_name}}" often converts as "{{<strong>student</strong>_name}}"
 * or with stray spaces. These helpers put every placeholder back together as
 * a clean {{key}} and list the fields found. Pure, for tests and the route.
 */

const PLACEHOLDER = /\{\{([\s\S]{1,200}?)\}\}/g;
const TAG = /<[^>]+>/g;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Keys reserved for signatures ({{signature}}, {{signature_2}}) stay as written. */
function isSignatureToken(key: string): boolean {
  return /^signature(_\d+)?$/.test(key);
}

export interface CleanedTemplate {
  html: string;
  fields: { key: string; label: string }[];
}

export function humanizeKey(key: string): string {
  const words = key.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function cleanImportedPlaceholders(html: string): CleanedTemplate {
  const seen = new Map<string, string>();
  // Word can also open a brace in one run and close it in another: "{<span>{</span>".
  const joined = html.replace(/\{((?:<[^>]+>)+)\{/g, '$1{{').replace(/\}((?:<[^>]+>)+)\}/g, '}}$1');
  const out = joined.replace(PLACEHOLDER, (whole, inner: string) => {
    const tags = inner.match(TAG) ?? [];
    const text = decodeEntities(inner.replace(TAG, '')).trim();
    let key = normalizeFieldKey(text);
    if (!key) return whole;
    // Placeholders must start with a letter ({{1st_name}} would never fill).
    if (!/^[a-z]/.test(key)) key = `field_${key}`;
    if (!isSignatureToken(key) && !seen.has(key)) seen.set(key, humanizeKey(key));
    // Formatting tags that were inside the braces move outside, balanced as they were.
    const opening = tags.filter((t) => !t.startsWith('</') && !t.endsWith('/>')).join('');
    const closing = tags.filter((t) => t.startsWith('</')).join('');
    // A tag that opened (or closed) inside and ends outside keeps its pair intact.
    if (opening && closing) return `${opening}{{${key}}}${closing}`;
    if (opening) return `{{${key}}}${opening}`;
    if (closing) return `${closing}{{${key}}}`;
    return `{{${key}}}`;
  });
  // [[signature:2]] split across runs is put back together the same way.
  const withSignatures = out.replace(/\[\[([\s\S]{1,120}?)\]\]/g, (whole, inner: string) => {
    const text = decodeEntities(inner.replace(TAG, '')).replace(/\s+/g, '');
    return /^signature(:[1-3])?(:(left|center|right))?$/i.test(text) ? `[[${text.toLowerCase()}]]` : whole;
  });
  return { html: withSignatures, fields: [...seen.entries()].map(([key, label]) => ({ key, label })) };
}

/** "https://docs.google.com/document/d/<id>/edit..." -> "<id>"; null for anything else. */
export function googleDocId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com') return null;
  const m = /^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})/.exec(u.pathname);
  return m ? m[1]! : null;
}
