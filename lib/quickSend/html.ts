import juice from 'juice';

/**
 * Pasted HTML emails (designed in another tool, or written by hand) are
 * usually styled with a <style> block and classes. Many inboxes (Outlook,
 * Gmail with non-Google accounts, some phone apps) ignore or strip <style>,
 * so the CSS is copied onto each element ("inlined"), keeping the <style>
 * block only for things that can't be inlined, such as @media rules for phones.
 */

export { looksLikeHtml } from './paste';

export function inlineEmailCss(html: string): string {
  if (!/<style[\s>]/i.test(html)) return html;
  try {
    return juice(html, {
      preserveMediaQueries: true,
      preserveFontFaces: true,
      applyWidthAttributes: true,
      applyHeightAttributes: true,
      removeStyleTags: true,
      insertPreservedExtraCss: true,
    });
  } catch {
    // Malformed CSS: send it as written rather than failing.
    return html;
  }
}
