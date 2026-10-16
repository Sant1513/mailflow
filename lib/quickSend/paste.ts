/**
 * Quick Send (browser-safe, no dependencies): a pasted plain list of
 * addresses with no header row becomes an "Email" column. Lines may hold one
 * address, or "Name, email" / "Name <email>". Anything that already starts
 * with a header row (copied from Sheets / Excel) is left as it is.
 */
const ADDRESS_RE = /[^\s,;<>\t"]+@[^\s,;<>\t"]+\.[^\s,;<>\t"]+/;

export function normalizePastedList(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return text;
  if (!ADDRESS_RE.test(lines[0]!)) return text;
  const rows = lines.map((line) => {
    const email = (line.match(ADDRESS_RE) ?? [''])[0];
    const name = line.replace(email, '').replace(/[<>"\t,;]+/g, ' ').replace(/\s+/g, ' ').trim();
    return { name, email };
  });
  const withNames = rows.some((r) => r.name);
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [withNames ? 'Name,Email' : 'Email', ...rows.map((r) => (withNames ? `${esc(r.name)},${esc(r.email)}` : esc(r.email)))].join('\n');
}

/** True when the text is HTML rather than plain words (a pasted email template). */
export function looksLikeHtml(text: string): boolean {
  const t = text.trim();
  if (/^<!doctype html|^<html[\s>]/i.test(t)) return true;
  const tags = t.match(/<\/?(p|div|table|tr|td|span|a|br|strong|b|em|h[1-6]|ul|ol|li|img|body|style)\b[^>]*>/gi) ?? [];
  return tags.length >= 3;
}
