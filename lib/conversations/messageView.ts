import { sanitizeEmailHtml } from '@/lib/templates/sanitize';
import { escapeHtml } from '@/lib/templates/variables';

/**
 * How a message is shown in the thread (§50). Pure functions so the quote
 * detection is unit-testable: Gmail / Outlook / Apple Mail each mark quoted
 * history differently, and a wrong split either hides the student's words
 * or shows a pyramid of quotes.
 */

export interface SplitBody {
  /** The new content, ready to render (HTML). */
  main: string;
  /** The quoted history, if any (HTML). */
  quoted: string | null;
}

/** Where quoted history starts in HTML, or -1. Covers Gmail, Outlook, Apple Mail, Yahoo, and generic blockquote. */
export function quotedHtmlStart(html: string): number {
  const markers = [
    /<div[^>]*class="[^"]*\bgmail_quote\b[^"]*"/i,
    /<div[^>]*class="[^"]*\bgmail_attr\b[^"]*"/i,
    /<div[^>]*id="[^"]*\b(divRplyFwdMsg|appendonsend)\b[^"]*"/i, // Outlook
    /<div[^>]*class="[^"]*\byahoo_quoted\b[^"]*"/i,
    /<blockquote[^>]*type="cite"/i, // Apple Mail
    /<div[^>]*class="[^"]*\bmoz-cite-prefix\b[^"]*"/i, // Thunderbird
    /<div[^>]*class="[^"]*\bOutlookMessageHeader\b[^"]*"/i,
  ];
  let best = -1;
  for (const re of markers) {
    const m = re.exec(html);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  if (best === -1) {
    // Generic "On … wrote:" line followed by a blockquote.
    const m = /On [^<\n]{5,200}wrote:\s*(<br\s*\/?>|<\/?[a-z][^>]*>)*\s*<blockquote/i.exec(html);
    if (m) {
      // Back up to the start of the element that contains the "On … wrote:" line.
      const open = html.lastIndexOf('<', m.index);
      best = open >= 0 ? open : m.index;
    }
  }
  return best;
}

const QUOTE_LINE_RE = /^(On .{5,200} wrote:|From: .+|-{2,} ?(Original|Forwarded) message ?-{2,}|_{5,}|Sent from my .+)$/im;

/** Where quoted history starts in plain text, or -1. */
export function quotedTextStart(text: string): number {
  const norm = text.replace(/\r\n/g, '\n');
  const m = QUOTE_LINE_RE.exec(norm);
  const firstQuoteLine = norm.search(/^\s*>/m);
  const candidates = [m?.index ?? -1, firstQuoteLine].filter((n) => n >= 0);
  return candidates.length ? Math.min(...candidates) : -1;
}

/** Plain text → safe HTML with paragraphs, line breaks and clickable links. */
export function textToHtml(text: string): string {
  const paras = text.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  return paras
    .map((p) => {
      const lines = p.split('\n').map((line) => linkify(escapeHtml(line)));
      return `<p>${lines.join('<br>')}</p>`;
    })
    .join('\n');
}

function linkify(escaped: string): string {
  return escaped.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

/**
 * Builds the renderable body for a message: HTML when present (sanitised),
 * otherwise the plain text converted; quoted history split off for a
 * "Show quoted text" toggle.
 */
export function splitMessageBody(input: { htmlBody?: string | null; plainTextBody?: string | null; snippet?: string | null }): SplitBody {
  if (input.htmlBody && input.htmlBody.trim()) {
    const clean = sanitizeEmailHtml(input.htmlBody);
    const at = quotedHtmlStart(clean);
    if (at > 0) {
      const main = clean.slice(0, at);
      // Only split when something meaningful is left in front of the quote.
      if (main.replace(/<[^>]+>/g, '').trim().length > 0) return { main, quoted: clean.slice(at) };
    }
    return { main: clean, quoted: null };
  }
  const text = (input.plainTextBody ?? input.snippet ?? '').trim();
  if (!text) return { main: '<p><em>(no text)</em></p>', quoted: null };
  const at = quotedTextStart(text);
  if (at > 0) {
    return { main: textToHtml(text.slice(0, at)), quoted: textToHtml(text.slice(at)) };
  }
  return { main: textToHtml(text), quoted: null };
}

export { frameDocument } from '@/lib/conversations/frameDoc';
