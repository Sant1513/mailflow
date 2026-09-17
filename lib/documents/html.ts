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
  // Substitute variables with yellow highlight — identical to signing preview
  let html = input.content;
  for (const [key, value] of Object.entries(input.fieldValues)) {
    html = html.replace(
      new RegExp(`\\{\\{${key}\\}\\}`, 'g'),
      `<mark style="background:#fef3c7;border-radius:2px;padding:0 2px;font-weight:600">${esc(value)}</mark>`
    );
  }
  html = html.replace(/\{\{\w+\}\}/g, '');

  const sigSrc = input.signatureImage.startsWith('data:')
    ? input.signatureImage
    : `data:image/png;base64,${input.signatureImage}`;

  const signedDate = input.signedAt.toUTCString();

  const fieldRows = Object.entries(input.fieldValues)
    .map(([k, v]) => `<tr><td class="fk">${esc(k.replace(/_/g, ' '))}</td><td>${esc(v)}</td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(input.title)}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
/* Same font stack as signing page (Tailwind default) */
body{font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.625;color:#1f2937;background:#f3f4f6;min-height:100vh}
.banner{background:#059669;color:#fff;padding:10px 24px;font-size:11.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;display:flex;align-items:center;justify-content:center;gap:8px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:760px;margin:24px auto 56px;padding:0 16px}
.card{background:#fff;border-radius:16px;border:1px solid #e5e7eb;box-shadow:0 1px 3px rgba(0,0,0,.07);overflow:hidden}
/* Document header */
.dh{padding:20px 32px 18px;border-bottom:1px solid #f3f4f6}
.dh-title{font-size:20px;font-weight:600;color:#111827}
.dh-meta{margin-top:4px;font-size:12.5px;color:#6b7280}
.dh-meta b{color:#374151}
/* Document content — matches signing page container exactly */
.doc-wrap{padding:16px 32px 8px}
.doc-label{font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#9ca3af;margin-bottom:8px}
.doc{border-radius:8px;border:1px solid #f3f4f6;background:#f9fafb;padding:16px 20px;font-size:14px;line-height:1.625;color:#1f2937}
.doc p{margin-bottom:8px}
.doc h1,.doc h2,.doc h3,.doc h4,.doc h5,.doc h6{font-weight:700;line-height:1.3;margin-top:14px;margin-bottom:4px}
.doc h1{font-size:20px}.doc h2{font-size:17px}.doc h3{font-size:15px}.doc h4{font-size:14px}
.doc ul,.doc ol{padding-left:20px;margin-bottom:8px}
.doc li{margin-bottom:2px}
.doc strong,.doc b{font-weight:700}
.doc em,.doc i{font-style:italic}
.doc hr{border:none;border-top:1px solid #e5e7eb;margin:12px 0}
.doc mark{-webkit-print-color-adjust:exact;print-color-adjust:exact}
/* Signature */
.sig{padding:16px 32px 20px;border-top:1px solid #f3f4f6;background:#f9fafb}
.sig-label{font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#9ca3af;margin-bottom:10px}
.sig-box{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:8px 14px;display:inline-block}
.sig-box img{display:block;max-height:80px;max-width:260px}
.sig-by{margin-top:8px;font-size:12px;color:#6b7280}
/* Certificate */
.cert{padding:20px 32px 24px;border-top:1px solid #e5e7eb}
.cert-title{font-size:13px;font-weight:600;color:#111827;margin-bottom:12px}
.ct{width:100%;border-collapse:collapse;font-size:13px}
.ct td{padding:6px 0;border-bottom:1px solid #f9fafb;vertical-align:top}
.ct td:first-child{color:#6b7280;width:145px;font-weight:500}
.ft{width:100%;border-collapse:collapse;font-size:12px;margin-top:2px}
.ft td{padding:2px 0;vertical-align:top}
.ft .fk{color:#9ca3af;width:185px;text-transform:capitalize}
.cert-note{margin-top:14px;font-size:11px;color:#9ca3af;line-height:1.5}
.hint{text-align:center;margin-top:16px;font-size:12px;color:#9ca3af}
@media print{
  body{background:#fff}
  .banner{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .page{margin:0;padding:0;max-width:none}
  .card{box-shadow:none;border-radius:0;border:none}
  .hint{display:none}
  @page{margin:14mm 16mm}
}
</style>
</head>
<body>
<div class="banner">
  <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
  Signed Document &nbsp;·&nbsp; ${esc(input.recipientName)} &nbsp;·&nbsp; ${signedDate}
</div>
<div class="page">
  <div class="card">
    <div class="dh">
      <div class="dh-title">${esc(input.title)}</div>
      <div class="dh-meta">Signed by <b>${esc(input.recipientName)}</b> &nbsp;·&nbsp; ${esc(input.recipientEmail)} &nbsp;·&nbsp; ${signedDate}</div>
    </div>
    <div class="doc-wrap">
      <div class="doc-label">Document</div>
      <div class="doc">${html}</div>
    </div>
    <div class="sig">
      <div class="sig-label">Electronic Signature</div>
      <div class="sig-box"><img src="${sigSrc}" alt="Signature of ${esc(input.recipientName)}"></div>
      <div class="sig-by">Signed by ${esc(input.recipientName)} &nbsp;·&nbsp; ${signedDate}</div>
    </div>
    <div class="cert">
      <div class="cert-title">Certificate of Completion</div>
      <table class="ct">
        <tr><td>Document</td><td>${esc(input.title)}</td></tr>
        <tr><td>Signer name</td><td>${esc(input.recipientName)}</td></tr>
        <tr><td>Signer email</td><td>${esc(input.recipientEmail)}</td></tr>
        <tr><td>Signed at</td><td>${signedDate}</td></tr>
        <tr><td>IP address</td><td>${esc(input.signerIp)}</td></tr>
        ${fieldRows ? `<tr><td>Field values</td><td><table class="ft">${fieldRows}</table></td></tr>` : ''}
      </table>
      <div class="cert-note">This document was signed electronically via MailFlow. The signature and audit trail above are legally binding.</div>
    </div>
  </div>
  <p class="hint">Ctrl+P / Cmd+P → Save as PDF to export</p>
</div>
</body>
</html>`;
}
