/**
 * Conversions behind the message editor's three views (Simple text, Rich, HTML). Pure, so they are tested without a browser.
 * Plain text → HTML is lossless; HTML → plain text drops formatting (the editor asks before doing it).
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ESCAPES[c]!);

/** Plain text → paragraphs: a blank line starts a paragraph, a single line break stays a line break. */
export function textToHtml(text: string): string {
  const t = text.replace(/\r\n?/g, '\n').trim();
  if (!t) return '';
  return t
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTML → plain text: paragraphs and line breaks become new lines, links keep their address, everything else is dropped. */
export function htmlToText(html: string): string {
  const body = bodyOf(html);
  return body
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').trim();
      return text && text !== href && !/^mailto:/i.test(href) ? `${text} (${href})` : text || href;
    })
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|blockquote|tr)>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return NAMED[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A whole designed email (page, head, styles) rather than a piece of content. The visual editor cannot keep one intact. */
export function isFullDocument(html: string): boolean {
  return /<\s*(!doctype|html|head|body|style)\b/i.test(html);
}

/** The content of a full document: what is inside <body>, or the text with the head, styles and doctype removed. */
export function bodyOf(html: string): string {
  const m = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  if (m) return m[1]!.trim();
  return html
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<\/?(html|body)\b[^>]*>/gi, '')
    .trim();
}

/** Fonts offered in the editor, with the generic family mail apps fall back to when the font is missing. */
export const EMAIL_FONTS: { name: string; fallback: 'sans-serif' | 'serif' | 'monospace' | 'cursive' }[] = [
  { name: 'Arial', fallback: 'sans-serif' },
  { name: 'Verdana', fallback: 'sans-serif' },
  { name: 'Tahoma', fallback: 'sans-serif' },
  { name: 'Trebuchet MS', fallback: 'sans-serif' },
  { name: 'Calibri', fallback: 'sans-serif' },
  { name: 'Helvetica', fallback: 'sans-serif' },
  { name: 'Georgia', fallback: 'serif' },
  { name: 'Times New Roman', fallback: 'serif' },
  { name: 'Garamond', fallback: 'serif' },
  { name: 'Courier New', fallback: 'monospace' },
  { name: 'Comic Sans MS', fallback: 'cursive' },
];

export const EMAIL_FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 36] as const;
