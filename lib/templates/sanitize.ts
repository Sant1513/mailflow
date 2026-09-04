import sanitizeHtml from 'sanitize-html';

/**
 * §23/§97: email preview must be sandboxed and XSS-safe. Template HTML is
 * authored by internal staff, but it is still untrusted input as far as the
 * app is concerned — a pasted snippet from anywhere could carry a script,
 * and previews render inside our own origin's page.
 *
 * Two layers protect the preview:
 *   1. this sanitizer strips scripts/handlers/dangerous URLs, and
 *   2. the preview renders inside a sandboxed <iframe> (see
 *      components/email-preview/EmailPreview.tsx).
 *
 * Note this is for PREVIEW only. The HTML actually sent to Gmail is the
 * author's original, because mail clients do their own sanitization and we
 * must not silently alter what an operator approved (§89 immutability).
 */
const EMAIL_TAGS = [
  'a', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'div', 'em', 'font',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre',
  'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'style', 'body', 'html', 'head',
  'title', 'meta',
];

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: EMAIL_TAGS,
    // sanitize-html warns that allowing <style> is XSS-prone. We allow it
    // deliberately: HTML emails genuinely need <style> blocks, and the
    // classic CSS-to-JS escapes (IE's expression(), -moz-binding) are dead
    // in every browser this app supports. The residual CSS risks — loading
    // a remote font/background, or CSS-selector data exfiltration — are
    // contained because previews render in an iframe with an empty
    // `sandbox` attribute (no scripts, no same-origin, no form submission).
    // Removing <style> would break legitimate templates for no real gain.
    allowVulnerableTags: true,
    allowedAttributes: {
      '*': ['style', 'class', 'align', 'valign', 'width', 'height', 'bgcolor', 'colspan', 'rowspan', 'border', 'cellpadding', 'cellspacing', 'dir', 'lang'],
      a: ['href', 'target', 'rel', 'style', 'class'],
      img: ['src', 'alt', 'title', 'width', 'height', 'style', 'class'],
      meta: ['charset', 'name', 'content'],
    },
    // Only these URL schemes may appear in href/src — blocks javascript:,
    // vbscript:, and file: entirely.
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
    allowProtocolRelative: false,
    // <style> content is kept (emails need it) but sanitize-html escapes it
    // safely; expression()/behavior: style attacks are legacy-IE only.
    allowedStyles: {},
    // Drop anything not explicitly allowed, including its contents for
    // script/style-like elements.
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed'],
    transformTags: {
      // Force external links to open safely if the preview is ever clicked.
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
    },
  });
}
