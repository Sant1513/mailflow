/**
 * HTML pretty-printer for the template editor. AI output (and many pasted
 * templates) arrive as one line; this puts block-level elements on their
 * own indented lines while leaving inline content, `<pre>`, `<script>`,
 * `<style>` and `<textarea>` byte-for-byte intact. It only ever inserts or
 * collapses whitespace BETWEEN block elements, so the rendered email is
 * unchanged.
 */

const BLOCK = new Set([
  'html', 'head', 'body', 'title', 'meta', 'link', 'base',
  'div', 'p', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'hr',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'form', 'fieldset', 'legend', 'center', 'address', 'figure', 'figcaption', 'details', 'summary',
]);
const VOID = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'col', 'base', 'area', 'source', 'wbr', 'embed', 'param', 'track']);
const RAW = new Set(['pre', 'script', 'style', 'textarea']);

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'comment'; value: string }
  | { kind: 'tag'; value: string; name: string; closing: boolean; selfClosing: boolean };

/** Splits HTML into tags/text/comments. Quoted attributes may contain '>' safely. */
export function tokenize(html: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      const stop = end === -1 ? html.length : end + 3;
      out.push({ kind: 'comment', value: html.slice(i, stop) });
      i = stop;
      continue;
    }
    if (html[i] === '<' && /[a-zA-Z/!]/.test(html[i + 1] ?? '')) {
      let j = i + 1;
      let quote: string | null = null;
      while (j < html.length) {
        const ch = html[j]!;
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === '>') {
          break;
        }
        j++;
      }
      const value = html.slice(i, j + 1);
      const m = /^<\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(value);
      const name = (m?.[1] ?? '').toLowerCase();
      out.push({ kind: 'tag', value, name, closing: value.startsWith('</'), selfClosing: /\/\s*>$/.test(value) });
      i = j + 1;
      continue;
    }
    const next = html.indexOf('<', i + 1);
    const stop = next === -1 ? html.length : next;
    out.push({ kind: 'text', value: html.slice(i, stop) });
    i = stop;
  }
  return out;
}

export function formatHtml(html: string, opts: { indent?: string } = {}): string {
  const indentUnit = opts.indent ?? '  ';
  const tokens = tokenize(html);
  const lines: string[] = [];
  let current = '';
  let depth = 0;
  // Open block tags, so an unclosed <p> does not leave everything after it
  // indented one level too deep: a close tag pops back to its opener.
  const stack: string[] = [];

  const flush = () => {
    if (current.trim() !== '') lines.push(indentUnit.repeat(depth) + current.trim());
    current = '';
  };

  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t]!;

    if (tok.kind === 'comment') {
      flush();
      lines.push(indentUnit.repeat(depth) + tok.value.trim());
      continue;
    }

    if (tok.kind === 'text') {
      // Collapse runs of whitespace; drop whitespace-only text that sits
      // between block tags (it is insignificant there).
      const collapsed = tok.value.replace(/\s+/g, ' ');
      if (collapsed.trim() === '') {
        if (current !== '' && !current.endsWith(' ')) current += ' ';
        continue;
      }
      current += collapsed;
      continue;
    }

    const isBlock = BLOCK.has(tok.name) || tok.name === '';
    if (RAW.has(tok.name) && !tok.closing) {
      // Emit the opening tag on its own line, then copy verbatim to the close tag.
      flush();
      let raw = '';
      let k = t + 1;
      for (; k < tokens.length; k++) {
        const inner = tokens[k]!;
        if (inner.kind === 'tag' && inner.closing && inner.name === tok.name) break;
        raw += inner.value;
      }
      const closeTag = k < tokens.length ? tokens[k]!.value : '';
      lines.push(indentUnit.repeat(depth) + tok.value + raw + closeTag);
      t = k;
      continue;
    }

    if (!isBlock) {
      current += tok.value;
      continue;
    }

    if (tok.closing) {
      flush();
      const at = stack.lastIndexOf(tok.name);
      if (at >= 0) {
        stack.length = at;
        depth = at;
      } else {
        depth = Math.max(0, depth - 1);
      }
      lines.push(indentUnit.repeat(depth) + tok.value);
      continue;
    }

    flush();
    lines.push(indentUnit.repeat(depth) + tok.value);
    if (!VOID.has(tok.name) && !tok.selfClosing) {
      stack.push(tok.name);
      depth++;
    }
  }
  flush();
  return lines.join('\n');
}

/** True when the HTML is effectively one long line (what the AI produces). */
export function looksMinified(html: string): boolean {
  const trimmed = html.trim();
  if (trimmed.length < 200) return false;
  const newlines = (trimmed.match(/\n/g) ?? []).length;
  return newlines < trimmed.length / 400;
}
