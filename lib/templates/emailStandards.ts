/**
 * Email standards check: does this template follow what mail clients need? Pure (no DOM), so it runs in the editor as you type,
 * in the health check before a send, and in tests. Nothing here blocks a send: every finding is "ok" or "warn" with the fix.
 *
 * What is checked, and why:
 *   document     doctype, <html lang>, viewport meta (phones), a title
 *   width        content no wider than 640px (mail apps show ~600px; wider means sideways scrolling)
 *   layout       table layout; flex / grid / position are dropped by Outlook and Gmail; layout tables carry role="presentation"
 *   images       alt text on every image, https, explicit width, not embedded as data: (Gmail drops them)
 *   links        real addresses (no "#" or empty), not "click here" (accessibility and spam filters)
 *   text         body text at least 14px; a font stack that ends in a generic family
 *   contrast     text on its background at least WCAG AA (4.5:1; 3:1 for large text)
 *   preheader    the hidden inbox preview line
 *   unsupported  script, form, iframe, video, audio, object, embed: removed by mail apps
 *   css          styles in the CSS tab become an embedded <style> block: key styles should also be inline
 *   text ratio   an email that is only pictures is filtered more often
 */
export type StandardLevel = 'ok' | 'warn';
export interface StandardItem {
  id: string;
  label: string;
  level: StandardLevel;
  detail?: string;
}
export interface StandardsResult {
  items: StandardItem[];
  warnCount: number;
}

interface Tag { name: string; attrs: Record<string, string>; raw: string; index: number }

const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function tagsOf(html: string, name: string): Tag[] {
  const out: Tag[] = [];
  const re = new RegExp(`<${name}\\b([^>]*)>`, 'gi');
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs: Record<string, string> = {};
    const src = m[1] ?? '';
    ATTR.lastIndex = 0;
    for (let a = ATTR.exec(src); a; a = ATTR.exec(src)) {
      if (a[1]) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    }
    out.push({ name, attrs, raw: m[0], index: m.index });
  }
  return out;
}

/** The CSS declarations of a style attribute as a map (property → value). */
function declarations(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (style ?? '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

function hex(v: string | undefined): [number, number, number] | null {
  const m = (v ?? '').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split('').map((c) => c + c).join('') : m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const lum = ([r, g, b]: [number, number, number]) => {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
/** WCAG contrast ratio between two hex colours (1 to 21). */
export function contrastRatio(a: string, b: string): number | null {
  const x = hex(a), y = hex(b);
  if (!x || !y) return null;
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const textOf = (html: string) =>
  html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&zwnj;/g, ' ').replace(/\s+/g, ' ').trim();

const GENERIC = /(sans-serif|serif|monospace|cursive|system-ui)\s*;?\s*$/i;
const VAGUE_LINK = /^(click here|here|read more|more|link|this link|click)$/i;

export function checkEmailStandards(html: string, css?: string | null): StandardsResult {
  const items: StandardItem[] = [];
  const add = (id: string, label: string, ok: boolean, detail?: string) => items.push({ id, label, level: ok ? 'ok' : 'warn', ...(detail ? { detail } : {}) });
  const body = html.trim();
  if (!body) return { items: [{ id: 'empty', label: 'Nothing to check yet', level: 'ok' }], warnCount: 0 };

  const full = /<\s*html\b/i.test(body);
  // ---- document ----
  if (full) {
    add('doctype', 'Doctype declared', /^\s*<!doctype html/i.test(body), 'Start the file with <!DOCTYPE html> so clients render in standards mode.');
    add('lang', 'Language set on <html>', tagsOf(body, 'html')[0]?.attrs.lang !== undefined, 'Add lang="en" (screen readers and spam filters use it).');
    add('viewport', 'Mobile viewport meta', tagsOf(body, 'meta').some((m) => (m.attrs.name ?? '').toLowerCase() === 'viewport'), 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> so phones do not shrink the email.');
    add('title', 'Document title', /<title\b[^>]*>\s*\S/i.test(body), 'Add a <title>.');
  }

  // ---- width ----
  const widths: number[] = [];
  for (const t of tagsOf(body, 'table')) {
    const w = parseInt(t.attrs.width ?? '', 10);
    if (Number.isFinite(w) && !(t.attrs.width ?? '').includes('%')) widths.push(w);
    const mw = declarations(t.attrs.style)['max-width'];
    if (mw && /px/.test(mw)) widths.push(parseInt(mw, 10));
  }
  const widest = widths.length ? Math.max(...widths) : 0;
  add('width', 'Content width 640px or less', widest <= 640, `A table is ${widest}px wide. Mail apps show about 600px; wider content scrolls sideways on laptops and phones.`);

  // ---- layout ----
  const styles = [...body.matchAll(/style\s*=\s*"([^"]*)"|style\s*=\s*'([^']*)'/gi)].map((m) => m[1] ?? m[2] ?? '');
  const embedded = [...body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? '').join('\n') + '\n' + (css ?? '');
  const unsupported = /display\s*:\s*(flex|grid)|position\s*:\s*(absolute|fixed|sticky)|\bfloat\s*:/i;
  add('layout', 'Table layout (no flex, grid, float or positioning)', !styles.some((s) => unsupported.test(s)) && !unsupported.test(embedded), 'Outlook and Gmail drop flex, grid, float and positioning. Use tables (the blocks do).');
  const layoutTables = tagsOf(body, 'table');
  const noRole = layoutTables.filter((t) => (t.attrs.role ?? '') !== 'presentation').length;
  if (layoutTables.length) add('role', 'Layout tables marked role="presentation"', noRole === 0, `${noRole} table${noRole === 1 ? '' : 's'} without role="presentation": screen readers read them as data tables.`);

  // ---- images ----
  const imgs = tagsOf(body, 'img');
  if (imgs.length) {
    const noAlt = imgs.filter((i) => i.attrs.alt === undefined).length;
    add('alt', 'Every image has alt text', noAlt === 0, `${noAlt} image${noAlt === 1 ? '' : 's'} without alt text. Many people see the alt text first (images are off by default in some apps). Use alt="" for pure decoration.`);
    const insecure = imgs.filter((i) => /^http:\/\//i.test(i.attrs.src ?? '')).length;
    const data = imgs.filter((i) => /^data:/i.test(i.attrs.src ?? '')).length;
    add('img-src', 'Images load over https, not embedded', insecure === 0 && data === 0, insecure ? `${insecure} image(s) use http://, which is blocked or warned about.` : `${data} image(s) are embedded as data:, which Gmail does not show. Host the image and link to it.`);
    const noWidth = imgs.filter((i) => !i.attrs.width && !declarations(i.attrs.style).width).length;
    add('img-width', 'Images have a width', noWidth === 0, `${noWidth} image(s) without a width: Outlook shows them at full size.`);
  }

  // ---- links ----
  const links = [...body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  if (links.length) {
    const dead = links.filter((m) => {
      const found = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[1] ?? '');
      const h = (found?.[1] ?? found?.[2] ?? '').trim();
      return !h || h === '#' || /^https?:\/\/$/i.test(h);
    }).length;
    add('links', 'Links go somewhere', dead === 0, `${dead} link(s) are empty, "#" or just "https://".`);
    const vague = links.filter((m) => VAGUE_LINK.test(textOf(m[2] ?? ''))).length;
    add('link-text', 'Link text says where it goes', vague === 0, `${vague} link(s) say "click here" or "read more": use words that describe the destination (better for screen readers and spam filters).`);
  }

  // ---- text ----
  const sizes = styles.map((s) => declarations(s)['font-size']).filter((v): v is string => !!v && /px/.test(v)).map((v) => parseFloat(v));
  const small = sizes.filter((s) => s < 14 && s > 0).length;
  // 12px is normal for a footer: only flag when most text is small.
  add('font-size', 'Body text is at least 14px', sizes.length === 0 || small <= Math.max(1, Math.floor(sizes.length / 3)), 'Most text is under 14px, which is hard to read on a phone.');
  const families = styles.map((s) => declarations(s)['font-family']).filter((v): v is string => !!v);
  const noGeneric = families.filter((f) => !GENERIC.test(f)).length;
  if (families.length) add('font-stack', 'Fonts end with a generic family', noGeneric === 0, `${noGeneric} font-family value(s) have no fallback like sans-serif: a client without the font falls back to a default.`);

  // ---- contrast ----
  const bad: string[] = [];
  for (const tag of [...body.matchAll(/<(\w+)\b([^>]*)>/g)]) {
    const attrs = tag[2] ?? '';
    const style = declarations(/style\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? /style\s*=\s*'([^']*)'/i.exec(attrs)?.[1]);
    const bg = style['background-color'] ?? style.background ?? /bgcolor\s*=\s*["']?(#[0-9a-f]{3,6})/i.exec(attrs)?.[1];
    const fg = style.color;
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg.split(/\s+/).find((p) => p.startsWith('#')) ?? bg);
    if (ratio === null) continue;
    const size = parseFloat(style['font-size'] ?? '16');
    const bold = /bold|[6-9]00/.test(style['font-weight'] ?? '');
    const large = size >= 24 || (size >= 18.66 && bold);
    if (ratio < (large ? 3 : 4.5)) bad.push(`${fg} on ${bg} (${ratio.toFixed(1)}:1)`);
  }
  add('contrast', 'Text is readable on its background', bad.length === 0, `Low contrast: ${[...new Set(bad)].slice(0, 3).join(', ')}. WCAG AA asks for 4.5:1 (3:1 for large text).`);

  // ---- preheader ----
  add('preheader', 'Inbox preview line (preheader)', /display\s*:\s*none[^"']*["'][^>]*>\s*[^<\s]/i.test(body), 'Add a hidden first line that summarises the email: apps show it next to the subject.');

  // ---- unsupported ----
  const banned = ['script', 'form', 'iframe', 'video', 'audio', 'object', 'embed', 'input'].filter((n) => new RegExp(`<${n}\\b`, 'i').test(body));
  add('unsupported', 'No scripts, forms or embedded media', banned.length === 0, `<${banned.join('>, <')}> are removed by mail apps. Link to a page or a video thumbnail instead.`);

  // ---- css ----
  if ((css ?? '').trim()) add('css', 'Key styles are inline', styles.length > 0, 'The CSS tab becomes an embedded <style> block. Most modern apps honour it, but some (older Outlook, Gmail in non-Google accounts, Yahoo) drop it. Keep the important styles inline.');

  // ---- text ratio ----
  if (imgs.length) add('text-ratio', 'Not only pictures', textOf(body).length >= 40, 'An email that is only images is filtered more often and unreadable with images off. Add real text.');

  return { items, warnCount: items.filter((i) => i.level === 'warn').length };
}
