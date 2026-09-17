export interface SignedHtmlInput {
  title: string;
  content: string;
  recipientName: string;
  recipientEmail: string;
  fieldValues: Record<string, string>;
  signatureImage: string;
  signedAt: Date;
  signerIp: string;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function generateSignedHtml(input: SignedHtmlInput): string {
  let html = input.content;
  for (const [key, value] of Object.entries(input.fieldValues)) {
    html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), esc(value));
  }
  html = html.replace(/\{\{\w+\}\}/g, '');

  const sigSrc = input.signatureImage.startsWith('data:')
    ? input.signatureImage
    : `data:image/png;base64,${input.signatureImage}`;

  const signedDate = input.signedAt.toUTCString();

  const fieldRows = Object.entries(input.fieldValues)
    .map(
      ([k, v]) =>
        `<tr><td class="fk">${esc(k.replace(/_/g, ' '))}</td><td>${esc(v)}</td></tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(input.title)}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:14px;line-height:1.7;color:#1a1a1a;background:#eef1f5;min-height:100vh}
/* ── Signed banner ── */
.banner{background:#059669;color:#fff;padding:10px 24px;font-size:12.5px;font-weight:600;letter-spacing:.04em;display:flex;align-items:center;justify-content:center;gap:8px;position:sticky;top:0;z-index:100;print-color-adjust:exact;-webkit-print-color-adjust:exact}
/* ── Layout ── */
.page{max-width:820px;margin:28px auto 56px;padding:0 16px}
.card{background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.1);overflow:hidden}
/* ── Document header ── */
.dh{padding:28px 44px 22px;border-bottom:1px solid #e5e7eb}
.dh-title{font-size:21px;font-weight:700;color:#111;margin-bottom:8px}
.dh-meta{font-size:12.5px;color:#6b7280;display:flex;flex-wrap:wrap;gap:12px 24px}
.dh-meta b{color:#374151}
/* ── Document body (the actual HTML content) ── */
.doc{padding:36px 44px;font-size:14px;line-height:1.75;color:#1a1a1a}
.doc p{margin-bottom:10px}
.doc h1,.doc h2,.doc h3,.doc h4,.doc h5,.doc h6{margin-top:18px;margin-bottom:6px;font-weight:700;line-height:1.3}
.doc h1{font-size:20px}.doc h2{font-size:17px}.doc h3{font-size:15px}.doc h4{font-size:14px}
.doc ul,.doc ol{padding-left:22px;margin-bottom:10px}
.doc li{margin-bottom:3px}
.doc strong,.doc b{font-weight:700}
.doc em,.doc i{font-style:italic}
.doc table{border-collapse:collapse;width:100%;margin-bottom:12px;font-size:13px}
.doc td,.doc th{padding:7px 10px;border:1px solid #d1d5db;text-align:left}
.doc th{background:#f9fafb;font-weight:600}
.doc center,.doc [style*="text-align:center"],[style*="text-align: center"]{text-align:center}
.doc hr{border:none;border-top:1px solid #d1d5db;margin:16px 0}
/* ── Signature ── */
.sig{padding:24px 44px;border-top:1px solid #e5e7eb;background:#f9fafb}
.sig-label{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#6b7280;margin-bottom:10px}
.sig-box{background:#fff;border:1px solid #d1d5db;border-radius:6px;padding:10px 16px;display:inline-block;max-width:320px}
.sig-box img{display:block;max-height:90px;max-width:280px}
.sig-by{margin-top:10px;font-size:12px;color:#6b7280}
/* ── Certificate ── */
.cert{padding:28px 44px;border-top:2px solid #e5e7eb}
.cert-title{font-size:15px;font-weight:700;color:#111;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.cert-title svg{color:#059669}
.ct{width:100%;border-collapse:collapse;font-size:13px}
.ct td{padding:7px 0;border-bottom:1px solid #f3f4f6;vertical-align:top}
.ct td:first-child{color:#6b7280;width:160px;font-weight:500}
.ft{width:100%;border-collapse:collapse;font-size:12px;margin-top:2px}
.ft td{padding:3px 0;vertical-align:top}
.ft .fk{color:#9ca3af;width:180px;text-transform:capitalize}
.cert-note{margin-top:16px;font-size:11.5px;color:#9ca3af;border-top:1px solid #f3f4f6;padding-top:12px;line-height:1.5}
/* ── Print hint ── */
.hint{text-align:center;margin-top:18px;font-size:12px;color:#9ca3af}
/* ── Print ── */
@media print{
  body{background:#fff}
  .banner{position:static;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .page{margin:0;padding:0;max-width:none}
  .card{box-shadow:none;border-radius:0}
  .hint{display:none}
  @page{margin:18mm 20mm}
}
</style>
</head>
<body>
<div class="banner">
  <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
  SIGNED DOCUMENT &nbsp;·&nbsp; ${esc(input.recipientName)} &nbsp;·&nbsp; ${signedDate}
</div>
<div class="page">
  <div class="card">
    <div class="dh">
      <div class="dh-title">${esc(input.title)}</div>
      <div class="dh-meta">
        <span>Signed by <b>${esc(input.recipientName)}</b></span>
        <span>${esc(input.recipientEmail)}</span>
        <span>${signedDate}</span>
      </div>
    </div>
    <div class="doc">${html}</div>
    <div class="sig">
      <div class="sig-label">Electronic Signature</div>
      <div class="sig-box"><img src="${sigSrc}" alt="Signature"></div>
      <div class="sig-by">Signed by ${esc(input.recipientName)} on ${signedDate}</div>
    </div>
    <div class="cert">
      <div class="cert-title">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
        Certificate of Completion
      </div>
      <table class="ct">
        <tr><td>Document</td><td>${esc(input.title)}</td></tr>
        <tr><td>Signer name</td><td>${esc(input.recipientName)}</td></tr>
        <tr><td>Signer email</td><td>${esc(input.recipientEmail)}</td></tr>
        <tr><td>Signed at</td><td>${signedDate}</td></tr>
        <tr><td>IP address</td><td>${esc(input.signerIp)}</td></tr>
        ${
          fieldRows
            ? `<tr><td>Field values</td><td><table class="ft">${fieldRows}</table></td></tr>`
            : ''
        }
      </table>
      <div class="cert-note">This document was signed electronically via MailFlow. The electronic signature and audit trail above constitute a legally binding record of the signing event.</div>
    </div>
  </div>
  <p class="hint">To save as PDF: File → Print (Ctrl+P / Cmd+P) → Save as PDF</p>
</div>
</body>
</html>`;
}
