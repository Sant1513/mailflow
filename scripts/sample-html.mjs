import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function generateSignedHtml(input) {
  let html = input.content;
  for (const [key, value] of Object.entries(input.fieldValues)) {
    html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), esc(value));
  }
  html = html.replace(/\{\{\w+\}\}/g, '');

  const signedDate = input.signedAt.toUTCString();

  const fieldRows = Object.entries(input.fieldValues)
    .map(([k,v]) => `<tr><td class="fk">${esc(k.replace(/_/g,' '))}</td><td>${esc(v)}</td></tr>`)
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
.banner{background:#059669;color:#fff;padding:10px 24px;font-size:12.5px;font-weight:600;letter-spacing:.04em;display:flex;align-items:center;justify-content:center;gap:8px;position:sticky;top:0;z-index:100;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:820px;margin:28px auto 56px;padding:0 16px}
.card{background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.1);overflow:hidden}
.dh{padding:28px 44px 22px;border-bottom:1px solid #e5e7eb}
.dh-title{font-size:21px;font-weight:700;color:#111;margin-bottom:8px}
.dh-meta{font-size:12.5px;color:#6b7280;display:flex;flex-wrap:wrap;gap:12px 24px}
.dh-meta b{color:#374151}
.doc{padding:36px 44px;font-size:14px;line-height:1.75;color:#1a1a1a}
.doc p{margin-bottom:10px}
.doc h1,.doc h2,.doc h3,.doc h4{margin-top:18px;margin-bottom:6px;font-weight:700;line-height:1.3}
.doc h1{font-size:20px}.doc h2{font-size:17px}.doc h3{font-size:15px}.doc h4{font-size:14px}
.doc ul,.doc ol{padding-left:22px;margin-bottom:10px}
.doc li{margin-bottom:3px}
.doc strong,.doc b{font-weight:700}
.doc em,.doc i{font-style:italic}
.doc hr{border:none;border-top:1px solid #d1d5db;margin:16px 0}
.sig{padding:24px 44px;border-top:1px solid #e5e7eb;background:#f9fafb}
.sig-label{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#6b7280;margin-bottom:10px}
.sig-box{background:#fff;border:1px solid #d1d5db;border-radius:6px;padding:10px 16px;display:inline-block}
.sig-box img{display:block;max-height:90px;max-width:280px}
.sig-by{margin-top:10px;font-size:12px;color:#6b7280}
.cert{padding:28px 44px;border-top:2px solid #e5e7eb}
.cert-title{font-size:15px;font-weight:700;color:#111;margin-bottom:14px}
.ct{width:100%;border-collapse:collapse;font-size:13px}
.ct td{padding:7px 0;border-bottom:1px solid #f3f4f6;vertical-align:top}
.ct td:first-child{color:#6b7280;width:160px;font-weight:500}
.ft{width:100%;border-collapse:collapse;font-size:12px;margin-top:2px}
.ft td{padding:3px 0;vertical-align:top}
.ft .fk{color:#9ca3af;width:200px;text-transform:capitalize}
.cert-note{margin-top:16px;font-size:11.5px;color:#9ca3af;border-top:1px solid #f3f4f6;padding-top:12px;line-height:1.5}
.hint{text-align:center;margin-top:18px;font-size:12px;color:#9ca3af}
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
      <div class="sig-box"><img src="${input.signatureImage}" alt="Signature"></div>
      <div class="sig-by">Signed by ${esc(input.recipientName)} on ${signedDate}</div>
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
      <div class="cert-note">This document was signed electronically via MailFlow. The electronic signature and audit trail above constitute a legally binding record of the signing event.</div>
    </div>
  </div>
  <p class="hint">To save as PDF: File → Print (Ctrl+P / Cmd+P) → Save as PDF</p>
</div>
</body>
</html>`;
}

// Sample using the real PAP Addendum content
const content = `<p style="text-align:center;"><strong>ADDENDUM TO THE PAY AFTER PLACEMENT AGREEMENT</strong></p>
<p style="text-align:center;">This Addendum to the Pay After Placement Agreement dated <strong>15th March 2025</strong>, (&ldquo;the First Addendum&rdquo;) is executed at Bangalore, Karnataka on this <strong>17th day of September, 2026</strong>, by and between:</p>
<p><strong>Abhishesh Kumar</strong> (Student Name), having Student ID <strong>MS2026042</strong> and <strong>ABCPK1234L</strong> (Student PAN number) and residing (currently) at <strong>123, MG Road, Bangalore, Karnataka - 560001</strong> (Current Address) (hereinafter referred to as the &ldquo;Student&rdquo;, &ldquo;Trainee&rdquo;, &ldquo;You&rdquo;, or &ldquo;Your&rdquo;, and which expression shall mean and include the legal heirs, executors and administrators of the student) of the ONE PART;</p>
<p style="text-align:center;"><strong>AND</strong></p>
<p><strong>Rajesh Kumar</strong> (Parent / Guardian / Spouse Name), having <strong>XYZPQ5678M</strong> (Parent PAN) and residing (currently) at <strong>123, MG Road, Bangalore, Karnataka - 560001</strong> (Parent Address) (hereinafter referred to as the &ldquo;Parent&rdquo;) of the SECOND PART.</p>
<p style="text-align:center;"><strong>AND</strong></p>
<p>Nolan Edutech Private Limited, a company incorporated under the Companies Act 2013 and having its registered office at Incubex 21, Building, No. 1178 5th Main Road, Sector 7 HSR Layout, Bangalore South, Bangalore, Karnataka - 560102 (hereinafter referred to as the &ldquo;Company&rdquo;) of the THIRD PART.</p>
<hr/>
<p><strong>WHEREAS:</strong></p>
<p>A. The Company is engaged in the business of providing training in software development, data science, data analytics, cybersecurity, and information technology through various courses and transforming candidates into skilled professionals.</p>
<p>B. You were desirous to enrol with the Company to receive such training and to that effect, entered into the Pay after Placement Agreement dated <strong>15th March 2025</strong> with the Company.</p>
<p>C. The terms and conditions of the Pay After Placement Agreement are valid, binding and effective as of the date of execution hereof.</p>
<p>D. The Student has requested the Company to extend the term of the Pay After Placement Agreement beyond its scheduled expiry date, and the Company has agreed to such extension subject to the terms and conditions set out in this Addendum.</p>
<hr/>
<p style="text-align:center;"><strong>NOW THIS ADDENDUM WITNESSETH AND IT IS HEREBY AGREED BY AND BETWEEN THE PARTIES IN CONSIDERATION OF THE TERMS AND CONDITIONS AND MUTUAL PROMISES AND REPRESENTATIONS CONTAINED HEREIN, THE PARTIES MUTUALLY AGREE HERETO AS FOLLOWS:</strong></p>
<p>1. All capitalized terms used in this First Addendum but not defined herein shall have the same meaning ascribed to it in the Pay After Placement Agreement.</p>
<p><strong>2. Extension of PAP Agreement</strong></p>
<p>a) The Parties acknowledge that the Pay After Placement Agreement is scheduled to expire on <strong>14th September 2026</strong> (&ldquo;Expiry Date&rdquo;).</p>
<p>b) At the request of the Student, and subject to the execution of this Addendum, the Company has agreed to extend the term of the Pay After Placement Agreement for an additional period of three (3) months commencing from <strong>15th September 2026</strong> and ending on <strong>14th December 2026</strong> (&ldquo;Extended Term&rdquo;).</p>
<p>c) During the Extended Term, the Student shall continue to be bound by and comply with all the terms and conditions of the Pay After Placement Agreement.</p>
<p>d) Except as expressly modified by this Addendum, all provisions of the Pay After Placement Agreement shall remain unchanged and continue in full force and effect.</p>`;

const fakeSignature = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAjAAAABkCAYAAACHKyWUAAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAB3RJTUUH6AkRCg0fIBMBLAAAAB1pVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVBkLmUHAAABUklEQVR42u3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAMBuAABHgAAAABJRU5ErkJggg==';

const result = generateSignedHtml({
  title: 'Addendum to Pay After Placement Agreement',
  content,
  recipientName: 'Abhishesh Kumar',
  recipientEmail: 'abhishesh.kumar@masaischool.com',
  fieldValues: {
    student_name: 'Abhishesh Kumar',
    student_id: 'MS2026042',
    student_pan: 'ABCPK1234L',
    parent_name: 'Rajesh Kumar',
    parent_pan: 'XYZPQ5678M',
    pap_agreement_date: '15th March 2025',
    expiry_date: '14th September 2026',
    extended_term_start_date: '15th September 2026',
    extended_term_end_date: '14th December 2026',
    student_address: '123, MG Road, Bangalore, Karnataka - 560001',
    parent_address: '123, MG Road, Bangalore, Karnataka - 560001',
  },
  signatureImage: fakeSignature,
  signedAt: new Date('2026-09-17T10:49:36Z'),
  signerIp: '106.51.72.9',
});

const outPath = join(__dirname, 'sample-signed.html');
writeFileSync(outPath, result, 'utf8');
console.log('Written:', outPath);
