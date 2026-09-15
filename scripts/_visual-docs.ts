// Temporary visual check (deleted after use): renders a realistic agreement the
// way a campaign would, writes it under public/_visual so pdf.js in the browser
// can draw the pages for a screenshot.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { renderDocument } from '../lib/documents/render';
import { documentFieldSchema } from '../lib/documents/types';
import { resolveField, resolveFileName } from '../lib/documents/values';

async function agreement() {
  const doc = await PDFDocument.create();
  const bold = doc.embedStandardFont(StandardFonts.HelveticaBold);
  const regular = doc.embedStandardFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawRectangle({ x: 0, y: 781, width: 595.28, height: 61, color: rgb(0.93, 0.01, 0.19) });
  page.drawText('MASAI SCHOOL', { x: 50, y: 805, size: 18, font: bold, color: rgb(1, 1, 1) });
  page.drawText('Placement Assistance Agreement', { x: 50, y: 740, size: 16, font: bold });
  const lines = [
    'This agreement is between Masai School and the student named below. The student',
    'agrees to attend placement sessions and respond to interview calls within 48 hours.',
  ];
  lines.forEach((l, i) => page.drawText(l, { x: 50, y: 710 - i * 16, size: 10.5, font: regular }));
  const label = (text: string, y: number) => page.drawText(text, { x: 50, y, size: 10.5, font: bold });
  label('Student name', 640);
  label('Batch', 606);
  label('Joining date', 572);
  label('Address', 538);
  label('I accept the terms', 470);
  page.drawLine({ start: { x: 150, y: 568 }, end: { x: 400, y: 568 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  const form = doc.getForm();
  form.createTextField('student_name').addToPage(page, { x: 150, y: 634, width: 260, height: 20 });
  const batch = form.createDropdown('batch');
  batch.addOptions(['FT-WEB-12', 'FT-WEB-13', 'FT-DATA-4']);
  batch.addToPage(page, { x: 150, y: 600, width: 160, height: 20 });
  form.createCheckBox('consent').addToPage(page, { x: 175, y: 466, width: 14, height: 14 });
  form.createTextField('signature_date').addToPage(page, { x: 380, y: 420, width: 150, height: 20 });
  page.drawText('Date', { x: 340, y: 426, size: 10.5, font: bold });
  return doc.save();
}

const fields = [
  { id: 'f1', label: 'Student name', value: '{{Name}}', format: { case: 'title' }, target: { kind: 'form', fieldName: 'student_name' } },
  { id: 'f2', label: 'Batch', value: '{{Batch}}', target: { kind: 'form', fieldName: 'batch' } },
  { id: 'f3', label: 'Joining date', value: '{{JoiningDate}}', format: { date: 'D MMMM YYYY' }, target: { kind: 'text', page: 0, x: 150, y: 257, width: 250, height: 18 } },
  { id: 'f4', label: 'Address', value: '{{Address}}', style: { multiline: true, fontSize: 10 }, target: { kind: 'text', page: 0, x: 150, y: 290, width: 250, height: 44 } },
  { id: 'f5', label: 'Consent', value: '{{Consent}}', required: false, target: { kind: 'form', fieldName: 'consent' } },
].map((f) => documentFieldSchema.parse(f));

async function main() {
  mkdirSync('public/_visual', { recursive: true });
  const original = await agreement();
  writeFileSync('public/_visual/original.pdf', original);
  const people = [
    { file: 'flatten.pdf', lockMode: 'FLATTEN' as const, data: { Name: 'rahul sharma', Batch: 'ft-web-13', JoiningDate: '2026-10-01', Address: '12, 4th Cross, MG Road\nIndiranagar, Bengaluru 560038', Consent: 'Yes' } },
    { file: 'lock.pdf', lockMode: 'LOCK_FILLED' as const, data: { Name: 'Priya Nair', Batch: 'FT-DATA-4', JoiningDate: '05/10/2026', Address: 'Flat 3B, Lake View Apartments, Kakkanad, Kochi, Kerala 682030', Consent: 'No' } },
  ];
  for (const p of people) {
    const system = { Today: '2026-09-10', DocumentId: 'MF-7K2Q9PX4', RecipientEmail: 'student@example.com' };
    const values = Object.fromEntries(fields.map((f) => [f.id, resolveField(f, p.data, system).value]));
    const out = await renderDocument({
      fileBytes: original,
      fields,
      values,
      lockMode: p.lockMode,
      stamp: { reference: 'MF-7K2Q9PX4', recipient: 'student@example.com', issuedLabel: '10 Sep 2026' },
      metadata: { title: resolveFileName('Agreement - {{Name}}', p.data, system, 'Agreement'), subject: 'Agreement', reference: 'MF-7K2Q9PX4', issuedAt: new Date('2026-09-10T05:00:00Z') },
    });
    writeFileSync(`public/_visual/${p.file}`, out.bytes);
    console.log(p.file, out.bytes.length, 'bytes', out.warnings);
  }
  copyFileSync('node_modules/pdfjs-dist/build/pdf.min.mjs', 'public/_visual/pdf.min.mjs');
  writeFileSync(
    'public/_visual/index.html',
    `<!doctype html><html><head><meta charset="utf-8"><title>Documents visual check</title>
<style>body{font-family:system-ui,sans-serif;background:#e5e7eb;margin:0;padding:12px}.row{display:flex;gap:12px;align-items:flex-start}h2{font-size:13px;margin:0 0 6px}canvas{background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);display:block}</style></head>
<body><div class="row" id="root"></div>
<script type="module">
import * as pdfjs from './pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
const items = [['original.pdf', 'Uploaded PDF'], ['flatten.pdf', 'Rahul, flattened'], ['lock.pdf', 'Priya, filled fields locked']];
for (const [file, label] of items) {
  const col = document.createElement('div');
  col.innerHTML = '<h2>' + label + '</h2>';
  document.getElementById('root').append(col);
  const doc = await pdfjs.getDocument(file).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 0.62 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width; canvas.height = viewport.height;
  col.append(canvas);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
}
document.body.dataset.done = '1';
</script></body></html>`
  );
  console.log('visual check written to public/_visual');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
