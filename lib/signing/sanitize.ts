import sanitizeHtml from 'sanitize-html';

/**
 * Signing documents are shown to signers on our own origin (the public /sign page) and to
 * teammates in the app, so their HTML must never carry script. This keeps everything a
 * document legitimately needs — the Word/Google Doc importer's inline CSS and <style> block,
 * tables with column widths, lists, images, links, our data-* page/slot markers, and the
 * {{fields}} / [[signature]] text — and removes scripts, event handlers (onerror=…), frames,
 * forms and javascript: URLs.
 */
const TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup', 'div', 'em', 'figcaption', 'figure',
  'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'li', 'mark', 'ol', 'p', 'pre', 'section',
  's', 'small', 'span', 'strike', 'strong', 'style', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
];

const ATTRS = ['style', 'class', 'id', 'align', 'valign', 'width', 'height', 'bgcolor', 'colspan', 'rowspan', 'span', 'border', 'cellpadding', 'cellspacing', 'dir', 'lang', 'title', 'data-*'];

export function sanitizeSigningHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: TAGS,
    // <style> is kept on purpose: imported documents carry their fonts and page rules in one.
    // Its text can't run script in any supported browser, and nothing else in it is executable.
    allowVulnerableTags: true,
    allowedAttributes: {
      '*': ATTRS,
      a: [...ATTRS, 'href', 'target', 'rel'],
      img: [...ATTRS, 'src', 'alt'],
      font: [...ATTRS, 'color', 'face', 'size'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowProtocolRelative: false,
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'frameset', 'template'],
  });
}
