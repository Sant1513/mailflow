/**
 * Makes every link in an outgoing email open correctly, however it was typed:
 * - hyperlinks written with double, single or no quotes;
 * - addresses without a scheme ("levelupcareer.in", "www.x.com", "//x.com"),
 *   which mail clients would otherwise treat as broken relative links;
 * - plain URLs pasted into the text, which become real links (and so can be
 *   click-tracked in campaigns).
 */

const ENTITY_MAP: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&lt;': '<', '&gt;': '>' };

function decodeAttr(value: string): string {
  return value.replace(/&(amp|quot|#39|#x27|lt|gt);/gi, (m) => ENTITY_MAP[m.toLowerCase()] ?? m).replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)));
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const BARE_DOMAIN_RE = /^(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i;

/**
 * The absolute http(s) URL a link should open, or null when it must be left
 * exactly as written (mailto:, tel:, in-page anchors, unfilled {{variables}},
 * other schemes, relative paths we can't resolve).
 */
export function normalizeHref(raw: string): string | null {
  let v = decodeAttr(raw).trim();
  if (!v || v.includes('{{') || /^(mailto:|tel:|sms:|#)/i.test(v)) return null;
  if (v.startsWith('//')) v = `https:${v}`;
  else if (/^https?:\/\//i.test(v)) {
    // already absolute
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    return null;
  } else if (BARE_DOMAIN_RE.test(v)) {
    v = `https://${v}`;
  } else {
    return null;
  }
  try {
    const url = new URL(v);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const HREF_ATTR_RE = /(\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * Rewrites the href of every <a> tag. `map` gets the normalized URL and returns
 * the href to use, or null to leave the tag untouched.
 */
export function rewriteLinks(html: string, map: (url: string) => string | null): string {
  return html.replace(/<a\s[^>]*>/gi, (tag) => {
    const m = HREF_ATTR_RE.exec(tag);
    if (!m) return tag;
    const url = normalizeHref(m[2] ?? m[3] ?? m[4] ?? '');
    if (!url) return tag;
    const next = map(url);
    if (next === null) return tag;
    return tag.replace(HREF_ATTR_RE, `${m[1]}href="${escapeAttr(next)}"`);
  });
}

const SKIP_TAGS = new Set(['a', 'style', 'script', 'head', 'title', 'textarea', 'code', 'pre']);
const PLAIN_URL_RE = /(^|[\s(>[{'"]|&nbsp;)((?:https?:\/\/|www\.)[^\s<>"']+)/gi;

function trimTrailingPunctuation(url: string): { url: string; rest: string } {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if ('.,;:!?\'"'.includes(ch)) end--;
    else if (ch === ')' && (url.slice(0, end).match(/\(/g)?.length ?? 0) < (url.slice(0, end).match(/\)/g)?.length ?? 0)) end--;
    else if (ch === ']' || ch === '}') end--;
    else break;
  }
  return { url: url.slice(0, end), rest: url.slice(end) };
}

/** Turns plain-text URLs into links, outside existing links, styles, scripts and code. */
export function autoLinkPlainUrls(html: string): string {
  const parts = html.split(/(<!--[\s\S]*?-->|<[^>]+>)/g);
  const open: string[] = [];
  return parts
    .map((part) => {
      if (part.startsWith('<')) {
        const tag = /^<\s*(\/)?\s*([a-z0-9-]+)/i.exec(part);
        if (tag) {
          const name = tag[2]!.toLowerCase();
          if (SKIP_TAGS.has(name) && !part.endsWith('/>')) {
            if (tag[1]) {
              const idx = open.lastIndexOf(name);
              if (idx >= 0) open.splice(idx, 1);
            } else {
              open.push(name);
            }
          }
        }
        return part;
      }
      if (open.length > 0 || !part) return part;
      return part.replace(PLAIN_URL_RE, (match, lead: string, rawUrl: string) => {
        const { url: text, rest } = trimTrailingPunctuation(rawUrl);
        const href = normalizeHref(text.replace(/&amp;/g, '&'));
        if (!href) return match;
        // `text` is already HTML source here, so it goes back in unchanged.
        return `${lead}<a href="${escapeAttr(href)}">${text}</a>${rest}`;
      });
    })
    .join('');
}

/** Link clean-up for any outgoing email (no tracking). */
export function normalizeEmailLinks(html: string): string {
  return rewriteLinks(autoLinkPlainUrls(html), (url) => url);
}
