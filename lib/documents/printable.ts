import { OUTFIT_LATIN_EXT_WOFF2, OUTFIT_LATIN_WOFF2 } from '@/lib/documents/fonts/outfit';
import { escapeHtml } from '@/lib/signing/fields';

/**
 * Page geometry for browser-rendered signing PDFs. The side margins leave a
 * 662px text column — the width of the document box on the signing page on
 * desktop — so lines wrap where the signer saw them wrap.
 */
export const PRINT_MARGINS = { top: 56, bottom: 64, left: 66, right: 66 } as const;

/*
 * The signing page shows template HTML under Tailwind's preflight reset and
 * the app's base layer, inside a 14px / 1.625 box. The same rules are copied
 * here so the PDF is a faithful print of what the signer reviewed. Template
 * <style> blocks come after this and win, exactly as they do in the app.
 */
const BASE_CSS = `
@font-face{font-family:'Outfit';font-style:normal;font-weight:300 800;src:url(data:font/woff2;base64,${OUTFIT_LATIN_WOFF2}) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Outfit';font-style:normal;font-weight:300 800;src:url(data:font/woff2;base64,${OUTFIT_LATIN_EXT_WOFF2}) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
*,::before,::after{box-sizing:border-box;border-width:0;border-style:solid;border-color:#e5e7eb}
html{-webkit-text-size-adjust:100%;tab-size:4;font-family:'Outfit',ui-sans-serif,system-ui,sans-serif;line-height:1.5}
body{margin:0;line-height:inherit;-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
hr{height:0;color:inherit;border-top-width:1px}
abbr:where([title]){text-decoration:underline dotted}
h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}
a{color:inherit;text-decoration:inherit}
b,strong{font-weight:bolder}
code,kbd,samp,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:1em}
small{font-size:80%}
sub,sup{font-size:75%;line-height:0;position:relative;vertical-align:baseline}
sub{bottom:-.25em}sup{top:-.5em}
table{text-indent:0;border-color:inherit;border-collapse:collapse}
blockquote,dl,dd,h1,h2,h3,h4,h5,h6,hr,figure,p,pre{margin:0}
fieldset{margin:0;padding:0}legend{padding:0}
ol,ul,menu{list-style:none;margin:0;padding:0}
img,svg,video,canvas,audio,iframe,embed,object{display:block;vertical-align:middle}
img,video{max-width:100%;height:auto}
[hidden]{display:none}
h1,h2,h3,h4,h5,h6{color:#0d0d10;font-family:'Outfit',ui-sans-serif,system-ui,sans-serif;font-weight:700;letter-spacing:-0.01em;line-height:1.15}
strong,b,th,dt{color:#0d0d10}
.doc{font-size:14px;line-height:1.625;color:#1f2937;font-weight:400}
.doc img,.doc [data-signature-slot]{break-inside:avoid}
`;

/** A complete, self-contained HTML page for printing a signing document. */
export function buildPrintableHtml(bodyHtml: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body><div class="doc">${bodyHtml}</div></body>
</html>`;
}

export function printFooterTemplate(label: string): string {
  // Header/footer templates render in their own context: styles must be inline.
  return `<div style="width:100%;padding:0 ${PRINT_MARGINS.right}px 0 ${PRINT_MARGINS.left}px;font-family:Helvetica,Arial,sans-serif;font-size:8px;color:#9ca3af;display:flex;justify-content:space-between;">
<span>${escapeHtml(label)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
}
