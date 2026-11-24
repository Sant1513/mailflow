/**
 * Email-safe building blocks for the template Visual editor. Each block is a self-contained snippet that follows the
 * conventions every serious email builder uses, so it renders the same in Gmail, Outlook (desktop Word engine included),
 * Apple Mail and phones:
 *   - table layout with role="presentation" (no flex/grid/position), every style inline;
 *   - fonts as a stack that ends in a generic family;
 *   - images block-level with explicit width, alt text and no border;
 *   - "bulletproof" buttons (padding and colour on the table cell, so Outlook shows them too);
 *   - two columns that stack on phones without media queries (fluid-hybrid), with a ghost table for Outlook;
 *   - a 600px container, the width mail apps display without scrolling.
 * Merge fields ({{Name}}) are plain text and stay untouched.
 */

export const FONT_STACK = "Arial, Helvetica, sans-serif";
export const CONTENT_WIDTH = 600;

export interface Brand {
  /** Page background behind the card. */
  pageBg: string;
  /** Card (content) background. */
  cardBg: string;
  text: string;
  accent: string;
  font: string;
}

export const DEFAULT_BRAND: Brand = { pageBg: '#f4f4f5', cardBg: '#ffffff', text: '#1a1a1a', accent: '#e5173f', font: FONT_STACK };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const TABLE = 'role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"';

/** A hidden line mail apps show next to the subject in the inbox list; padded so the body text does not leak into it. */
export function preheaderBlock(text: string, pageBg = DEFAULT_BRAND.pageBg): string {
  const pad = '&zwnj;&nbsp;'.repeat(60);
  return `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:${pageBg}">${esc(text)}${pad}</div>`;
}

/** A complete email document: head with the standard meta tags, the page background and a centred 600px card. */
export function starterLayout(opts: { title?: string; preheader?: string; brand?: Partial<Brand>; body?: string } = {}): string {
  const b: Brand = { ...DEFAULT_BRAND, ...opts.brand };
  const body =
    opts.body ??
    [headingBlock('Your headline here', 1, b), textBlock('Hi {{Name}},', b), textBlock('Write your message here. Keep it short, one idea per paragraph, and put the action in a button.', b), buttonBlock('Take the action', 'https://', b), textBlock('Regards,<br>Placement Team', b)].join('\n');
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(opts.title ?? 'Email')}</title>
</head>
<body style="margin:0;padding:0;background:${b.pageBg};">
${preheaderBlock(opts.preheader ?? 'A short summary that appears next to the subject in the inbox.', b.pageBg)}
<table ${TABLE} style="background:${b.pageBg};">
<tr>
<td align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="${CONTENT_WIDTH}" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${CONTENT_WIDTH}px;background:${b.cardBg};border-radius:8px;">
<tr>
<td style="padding:32px;font-family:${b.font};font-size:16px;line-height:24px;color:${b.text};">
${body}
</td>
</tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td>
</tr>
</table>
</body>
</html>
`;
}

export function headingBlock(text = 'Heading', level: 1 | 2 | 3 = 2, b: Brand = DEFAULT_BRAND): string {
  const size = level === 1 ? 28 : level === 2 ? 22 : 18;
  return `<table ${TABLE}><tr><td style="padding:8px 0 12px;"><h${level} style="margin:0;font-family:${b.font};font-size:${size}px;line-height:${size + 8}px;font-weight:bold;color:${b.text};">${esc(text)}</h${level}></td></tr></table>`;
}

/** Text may contain simple inline HTML (br, b, a); it is written as given. */
export function textBlock(html = 'Write your text here.', b: Brand = DEFAULT_BRAND): string {
  return `<table ${TABLE}><tr><td style="padding:0 0 16px;"><p style="margin:0;font-family:${b.font};font-size:16px;line-height:24px;color:${b.text};">${html}</p></td></tr></table>`;
}

export function imageBlock(src = 'https://', alt = 'Describe the image', width = 536, href = ''): string {
  const img = `<img src="${esc(src)}" width="${width}" alt="${esc(alt)}" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;outline:none;text-decoration:none;">`;
  return `<table ${TABLE}><tr><td style="padding:0 0 16px;">${href ? `<a href="${esc(href)}" target="_blank">${img}</a>` : img}</td></tr></table>`;
}

/** Bulletproof button: the colour and padding live on the cell, so Outlook (Word engine) draws it too. */
export function buttonBlock(label = 'Button', href = 'https://', b: Brand = DEFAULT_BRAND, align: 'left' | 'center' = 'left'): string {
  return `<table ${TABLE}><tr><td align="${align}" style="padding:8px 0 16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${b.accent}" style="border-radius:6px;background:${b.accent};padding:14px 28px;"><a href="${esc(href)}" target="_blank" style="display:inline-block;font-family:${b.font};font-size:16px;line-height:20px;font-weight:bold;color:#ffffff;text-decoration:none;">${esc(label)}</a></td></tr></table></td></tr></table>`;
}

export function dividerBlock(): string {
  return `<table ${TABLE}><tr><td style="padding:8px 0 16px;"><table ${TABLE}><tr><td height="1" style="height:1px;font-size:1px;line-height:1px;border-top:1px solid #e4e4e7;">&nbsp;</td></tr></table></td></tr></table>`;
}

export function spacerBlock(height = 24): string {
  return `<table ${TABLE}><tr><td height="${height}" style="height:${height}px;font-size:${height}px;line-height:${height}px;">&nbsp;</td></tr></table>`;
}

/** Two columns side by side on desktop, stacked on a phone (no media queries needed); Outlook gets a ghost table. */
export function twoColumnBlock(left = 'Left column', right = 'Right column', b: Brand = DEFAULT_BRAND): string {
  const col = (html: string) => `<div style="display:inline-block;width:100%;max-width:268px;vertical-align:top;font-family:${b.font};font-size:16px;line-height:24px;color:${b.text};text-align:left;"><table ${TABLE}><tr><td style="padding:0 8px 16px;">${html}</td></tr></table></div>`;
  return `<table ${TABLE}><tr><td style="font-size:0;line-height:0;text-align:center;">
<!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="50%" valign="top"><![endif]-->
${col(left)}
<!--[if mso]></td><td width="50%" valign="top"><![endif]-->
${col(right)}
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>`;
}

/** Small grey print: address, why they received it. (MailFlow adds the unsubscribe link itself when sending.) */
export function footerBlock(text = 'Masai School · Bengaluru, India. You are receiving this because you are on our placement list.', b: Brand = DEFAULT_BRAND): string {
  return `<table ${TABLE}><tr><td style="padding:16px 0 0;border-top:1px solid #e4e4e7;"><p style="margin:0;font-family:${b.font};font-size:12px;line-height:18px;color:#6b7280;">${esc(text)}</p></td></tr></table>`;
}

export const BLOCKS: { id: string; label: string; html: () => string }[] = [
  { id: 'heading', label: 'Heading', html: () => headingBlock() },
  { id: 'text', label: 'Paragraph', html: () => textBlock() },
  { id: 'image', label: 'Image', html: () => imageBlock() },
  { id: 'button', label: 'Button', html: () => buttonBlock() },
  { id: 'columns', label: 'Two columns', html: () => twoColumnBlock() },
  { id: 'divider', label: 'Divider', html: () => dividerBlock() },
  { id: 'spacer', label: 'Spacer', html: () => spacerBlock() },
  { id: 'footer', label: 'Footer note', html: () => footerBlock() },
];
